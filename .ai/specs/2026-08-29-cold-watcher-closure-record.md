# Cold Watcher Closure Record

**Status:** Closure record (2026-08-29). **No code change for the reported defect.** It is fixed,
merged, live and verified. This spec records the closure against evidence re-measured in this
step, and specs the bounded residue the fix runs left behind.

> **Task:** `abfcdb9c-e63b-4c0c-95c3-d331a86e39f7`. Board todos
> `f09bf585-f4fa-416f-a979-5bbd0dac22ed` (autostart half) and
> `503195a8-1f77-4ff5-b9b7-7a6606a5d639` (reopen half) both read `status: "done"` in
> `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json`, read directly in this step.
>
> **Brief:** `.ai/specs/briefs/2026-08-29-lazy-watchers-already-shipped.md` (step 1 of this run).
> Every load-bearing claim in it was re-opened against the code and the running system while
> writing this spec. It holds up, with **two corrections** recorded below (Problem §3).
>
> **Predecessor specs, both read:**
> `.ai/specs/2026-08-25-lazy-project-watchers.md` (root cause + fix, task
> `1f5aa96e-1254-4b78-a603-0307ff0fee94`) and
> `.ai/specs/2026-08-25-cold-watcher-production-verification.md` (verification, this same task id).
> This spec supersedes neither. It closes them out and corrects their status blocks.
>
> **Naming note:** this repo has **no** `tools/next-spec` allocator: there is no `tools/`
> directory at all, and `scripts/` holds only `activate-main.sh`, `dev.mjs`, `release.mjs`,
> `release-snapshot.mjs`, `write-build-stamp.mjs`. Of 204 files in `.ai/specs/`, **190** use the
> `YYYY-MM-DD-slug` convention and **0** use `SPEC-NNN`. This file follows the majority
> convention. No number was inferred from a directory listing.

## TLDR

`cez todo start <id>` sets `autostart: true` and relies on the running cockpit's watcher to turn
that into a run. Those watchers were wired only for **resident** project contexts, and contexts
build lazily, so a registered project nobody had opened since the last restart had no watcher on
its `todos.json` or `reopen-requests.json`. The flag was written and never read, silently, in both
directions.

That defect was fixed by `809c8220` ("feat: implement lazy project watchers"), merged as
`e8a2b1d6`, and is **running in production right now**: the live release symlink is
`/opt/cezar -> /opt/cezar-releases/20260829T140342Z-95b93175`, `809c8220` is an ancestor of
`95b93175`, and `/opt/cezar/packages/cezar/dist/server/lazy-project-intents.js` exists in the
installed build with its pending-gate intact. All five acceptance criteria are met.

What is left is not the defect. It is four pieces of residue the fix and its canaries left behind,
none of which change runtime behaviour and one of which will actively mislead the next person who
runs a cold-project canary:

1. A disposable canary todo stranded in a **real** project's board (`mw-site`).
2. An orphaned canary worktree on disk in `mw-site`.
3. Two spec status blocks that still say `QA Needed` / `in-progress` for work now `done`.
4. A residency probe that measures inotify and therefore **structurally cannot see** the new
   poller's coverage, so it reports a correctly-covered cold project as uncovered.

## Problem

### 1. The original defect, as filed

`packages/cezar/src/server/server.ts` wires both intent watchers with an identical three-clause
shape: the boot context, the contexts already built, and an `onContextBuilt` callback. Read at
current HEAD, lines ~1946–1966, that wiring is **unchanged** by the fix:

```ts
watchTodoAutostart(todoAutostartProject(bootContext));
for (const id of contexts.ids()) {
  const ctx = contexts.peek(id);
  if (ctx) watchTodoAutostart(todoAutostartProject(ctx));
}
contexts.onContextBuilt((ctx) => watchTodoAutostart(todoAutostartProject(ctx)));
```

…followed by the same three clauses for `watchReopenRequests`. All three clauses only ever reach a
project that **already has a context**. `ProjectContexts.context()` (`project-context.ts:320`)
builds on first API touch, so a registered-but-never-touched project matches none of them.

`todo-cli.ts:230-245` states the contract that makes this fatal rather than cosmetic:

> This does NOT start a run. It sets `autostart: true`, and the RUNNING COCKPIT's `todos.json`
> watcher (`todo-autostart.ts`) turns that into a run

So `input-to-tasks`' dispatch step, which runs `cez todo start <id> --project <p>` across every
project it filed into, wrote an inert flag for every non-resident project. The failure is silent on
both sides: the todo shows the flag, and no run ever appears.

### 2. It is already fixed, and I re-verified that rather than trusting the brief

| Claim | How it was checked in this step | Result |
| --- | --- | --- |
| Fix module exists | `ls packages/cezar/src/server/lazy-project-intents.ts` | present, 337 lines |
| Fix is merged | `git merge-base --is-ancestor 809c8220 origin/main` | exit 0 |
| Tests are merged | `git merge-base --is-ancestor 7a769b94 origin/main` | exit 0 |
| Fix is **live** | `readlink /opt/cezar` → `…-95b93175`; `git merge-base --is-ancestor 809c8220 95b93175` | exit 0 |
| Fix is in the installed build | `ls /opt/cezar/packages/cezar/dist/server/lazy-project-intents.js` | present |
| Live build still gates on pending | `grep -c "contexts.context"` on that dist file | exactly **1** |
| Service is up on it | `systemctl show cezar.service` | `ActiveState=active`, started `2026-08-29 14:03:47 UTC` |

The mechanism, read at HEAD rather than assumed:

- `server.ts:234` imports `createLazyProjectIntentDiscovery`; `server.ts:7778` instantiates it and
  `:7787` calls `refresh()`, both inside `startServer` and therefore **after** `createApp` has
  registered both `onContextBuilt` callbacks. A woken project is armed for autostart *and* reopen
  in the same turn it becomes resident. `:7898` stops it on drain.
- `lazy-project-intents.ts:282-286` is the criterion-2 gate: if neither
  `pendingSources.autostart` nor `pendingSources.reopen` is set, `inspect()` **returns** before
  reaching the single `deps.contexts.context(row.id)` call at `:296`. No pending flag, no context
  build, so no `pruneOrphans` and no `RunManager` recovery for an idle project.
- Criterion 3 holds by construction, not by care: the poller reads
  `readTodoAutostartSnapshot` / `readReopenIntentSnapshot` and never calls `startWatch`.
  `reopen-requests.ts:220` documents the snapshot reader as reading "without taking a lease,
  subscribing, or creating a directory", while the `mkdirSync(dataDir, {recursive: true})` that
  *would* create `.ai/cezar` lives in `startWatch` (`reopen-requests.ts:327`), which the poller
  never reaches. The poller's own docblock (`:72-76`) states this as its reason for existing.
- Criterion 4, the twins, both exist and both boot the real server path:
  `todo-autostart.test.ts:230` `describe('cold-project autostart discovery')` → `it('boots the real
  server path and wakes a non-resident project only after a pending todo')`, and
  `reopen-watch.test.ts:226` `describe('cold-project reopen discovery')` → the same sentence for a
  pending request. Neither is a unit test of the poller in isolation; both drive `startServer`, so
  cutting either the resident `onContextBuilt` arming or the poller's `context()` call fails them.

**A live positive control for criterion 2, measured in this step.** `mw-site` is non-resident right
now (see §4 for the probe and its caveat) and its `todos.json` holds two todos, `de8eb687` and
`c2231b8c`, **neither carrying `autostart: true`**. The poller has therefore been polling a cold
project with todos and correctly declining to build its context. That is criterion 2 demonstrated
against the running system, not against a fixture.

### 3. Two corrections to the inherited record

**Correction A. The stranded canary is in `mw-site`, not on the cezar board.** Searching the cezar
board (206 todos) for `c2231b8c` returns nothing, which reads as "already cleaned up". It is not:
it lives in `/var/lib/cezar/loki-labs/mw-site/.ai/cezar/todos.json`, still `status: "todo"`. Anyone
closing this out by grepping the cezar board alone will wrongly conclude the residue is gone.

**Correction B. The canary is inert, and the brief did not establish that.** The brief flags the
canary as still pending but does not say whether it can re-fire. It cannot, for two independent
reasons, both read in this step: its record carries no `autostart` field (the flag was consumed
when the run started), and it carries `startedTaskId: "dc24830f-6045-4d69-871c-6da692fc5448"`,
which `todo-cli.ts:243` refuses:

> Refuses a todo that is archived, tombstoned, or already picked up (`startedTaskId`)

So this is **litter, not a live loop**. That distinction sets the priority of P2 below: it is
hygiene, not an incident.

The brief's own correction of the stale handoff also holds: run `dc24830f` is
`status: "failed"`, `finishedAt: 2026-08-29T13:28:35.131Z`, `stepsUsed: 10`, not "queued with 9
steps pending" as the resume notes still say.

### 4. The residency probe is blind to the fix, and will read false-green

This is the one item here with teeth, and it is a **new** finding from this step.

The runbook's non-residency probe matches project `dataDir` inodes against the server PID's inotify
fdinfo. Run against live PID `1046718`:

```
mw-site          ino=681720  watched_matches=0
loki-labs/cezar  ino=681730  watched_matches=1
chat             ino=681737  watched_matches=0
```

That probe measures **inotify** watches, which is what the resident `fs.watch`-based domain
watchers create. The cold-intent poller deliberately uses `watchFile` (`lazy-project-intents.ts:1`,
`:161`, `:313`), which is **stat polling and creates no inotify watch at all**.

Therefore `watched_matches=0` is the *expected and correct* reading for a cold project that the
poller is covering perfectly. The probe cannot distinguish:

- cold and covered by the poller (fixed, healthy), from
- cold and covered by nothing (the original defect).

It answers a question adjacent to the one the canary is asking. It remains valid for its **actual**
job (selecting a genuinely non-resident canary target *before* writing an intent), and that is the
only job it may be used for. Reading it as a verdict on coverage is how a future session concludes
the fix regressed when it has not, or that it works when it does not.

## Solution

Do not touch the fix. Record the closure, clear the residue, and constrain the probe to the
question it can actually answer.

1. **Leave `lazy-project-intents.ts`, `server.ts` and both watcher paths alone.** Re-implementing
   risks exactly the two failure modes the acceptance criteria forbid: a second discovery mechanism
   racing the first, or a well-meaning "just build every registered context at boot" that
   reintroduces eager `pruneOrphans` + `RunManager` recovery for idle projects.
2. **Close the record in place.** The two predecessor specs still advertise `QA Needed` /
   `in-progress` for work whose board todos are `done`.
3. **Remove the canary residue** from `mw-site`, a real project that should not carry another
   task's test fixtures.
4. **Annotate the probe** at its definition site with what it cannot see, so the next canary is
   designed around the blind spot rather than into it.

## Architecture

As-built, after `809c8220`. Nothing in this diagram changes.

```
                startServer()
                     │
   createApp() ──────┤  registers BOTH onContextBuilt callbacks FIRST
                     │    ├─ watchTodoAutostart   (resident, fs.watch → inotify)
                     │    └─ watchReopenRequests  (resident, fs.watch → inotify)
                     │
   createLazyProjectIntentDiscovery()   ← armed strictly AFTER the callbacks exist
                     │
                     ▼
        for each REGISTERED project where contexts.peek(id) === undefined
                     │
                     │  watchFile(todos.json), watchFile(reopen-requests.json)
                     │  ── stat polling, no inotify, no mkdir, no lease ──
                     ▼
              inspect(row)
                     │
      readTodoAutostartSnapshot ─┐
      readReopenIntentSnapshot ──┤ passive reads; missing file/dir ⇒ absent, no side effect
                                 ▼
                   pending?  ──no──▶ return  (criterion 2: no context build)
                                 │
                                yes
                                 ▼
                    contexts.context(id)          ← the ONLY build call
                                 │
                                 ▼
                    fires onContextBuilt ⇒ BOTH resident watchers arm
                                 │
                                 ▼
                    stopObservation(id)  : poller hands the project over and lets go
```

The load-bearing ordering is that discovery is armed **after** `createApp`. Reversed, a discovered
context could become resident before either callback is registered and would be armed for neither
watcher, which is the original defect reached by a longer route.

Residue locations:

| Item | Path |
| --- | --- |
| Canary todo `c2231b8c` | `/var/lib/cezar/loki-labs/mw-site/.ai/cezar/todos.json` |
| Canary run `dc24830f` | `/var/lib/cezar/loki-labs/mw-site/.ai/cezar/runs.json` |
| Orphaned worktree | `/var/lib/cezar/loki-labs/mw-site/.ai/cezar/worktrees/dc24830f-…` |
| Stale status blocks | `.ai/specs/2026-08-25-lazy-project-watchers.md`, `…-cold-watcher-production-verification.md` |
| Probe blind spot | the canary runbook in `…-cold-watcher-production-verification.md` |

## Phases

Each phase is independently shippable and independently revertible. **P1 is the only one required
to close this task**; P2–P4 are hygiene and may land separately or be dropped without reopening the
defect.

### P1. Close the record (docs only)

Mark both predecessor specs closed, in place, per the correct-in-place rule: a bolded
`CORRECTED 2026-08-29` / `VERIFIED 2026-08-29` lead-in at the top of each status block, original
text preserved below it, naming this spec as where the closure is recorded.

- `.ai/specs/2026-08-25-lazy-project-watchers.md`: its status/execution record predates
  production verification.
- `.ai/specs/2026-08-25-cold-watcher-production-verification.md`: its status block still describes
  `f09bf585` as `in-progress` and both KB entries as `QA Needed`; the board now reads `done` for
  both todos.
- **`/var/lib/cezar/loki-labs/notion-export/domains/cezar.md`, under `## Current state`.** This is
  the curated domain index, i.e. the first thing the next session reads, and it is the most
  load-bearing stale entry of the three. Its **first** bullet (lines 17-25, read in this step)
  still opens `**IMPLEMENTED 2026-08-25, QA Needed: cold project intent discovery for autostart
  and reopen.**` and closes `Production cold-project canaries were not run because the manual
  deployment handoff remains unresolved.` Both halves are now false. Required correction: a bolded
  `CORRECTED 2026-08-29` lead-in on that bullet, original text preserved unchanged below it,
  recording that
  - the `mw-site` **autostart** canary passed — the run appeared **4 seconds** after the intent was
    written (`startedTaskId = dc24830f-6045-4d69-871c-6da692fc5448`),
  - the `loki-labs` **reopen** canary passed — the continuation started **6 seconds** after
    (`startedAt = 2026-08-29T12:37:45.659Z`),
  - both board todos (`f09bf585`, `503195a8`) now read `done`, and
  - **no deployment was required**: production already contained the fix
    (`deploy.sha = 176376293522fc5be915fe60713c9ea5cd7df3c3`, activated `2026-08-29T11:15:27.770Z`;
    `git merge-base --is-ancestor 809c8220 17637629` answers yes, re-run in this step). The
    manual-deploy park named in that bullet dissolved rather than being resolved.

  **Do not edit the mounted document directly.** Per the workspace rule, a corpus correction goes
  through the proposal channel: append an NDJSON `supersede`/`upsert` line to `CEZ_KB_WRITE_FILE`
  (this run: `.ai/cezar/runs/abfcdb9c-….knowledge.ndjson`, currently 0 bytes, so the first line is
  `seq: 0`), and it is reviewed and applied later via the cockpit or `cez kb proposals` — never
  automatically. **Record closure may not be claimed until `cez kb search` returns the corrected
  state**, which on this box also requires the reindex (`cd /var/lib/cezar/loki-labs && CEZ_KB=1
  cez kb reindex`), because a corpus write is not a KB write until it is indexed. If applying the
  proposal needs a person, this phase ships with the corpus sync marked **explicitly pending**, in
  the handoff and in this spec, rather than reported as done.

No code, no tests, no deploy.

### P2. Clear the canary fixture from `mw-site`

Tombstone or archive todo `c2231b8c-85af-4869-8439-eea9f6442fb1`.

**This phase is blocked for an agent, by design, and that is the finding.** `todo-cli.ts:49` sets
`KNOWN_SUBCOMMANDS = new Set(['add', 'list', 'start'])`. There is no `tombstone`, `done`, `archive`
or `rm` verb, and the HTTP path answers 401 to a headless caller. So this is a cockpit click by the
owner, or it stays. Do not hand-edit `mw-site/.ai/cezar/todos.json`: it is a live file owned by a
running server that holds it under a lease, and a concurrent write races the server's own
atomic replace.

Ship P1 without waiting on this.

### P3. Reap the orphaned canary worktree

The target is a **registered, existing** worktree, not a stale administrative entry: read in this
step, `git -C /var/lib/cezar/loki-labs/mw-site worktree list --porcelain` lists

```
worktree /var/lib/cezar/loki-labs/mw-site/.ai/cezar/worktrees/dc24830f-6045-4d69-871c-6da692fc5448
HEAD eb9077af035c664e6fd8110c036226cdd9d1aaab
branch refs/heads/cez/dc24830f
```

so **`git worktree prune` will not remove it** — prune only clears entries whose directory is
already gone. The exact sequence, in this order:

```bash
W=/var/lib/cezar/loki-labs/mw-site/.ai/cezar/worktrees/dc24830f-6045-4d69-871c-6da692fc5448
git -C "$W" status --short                                    # MUST be empty before removing
git -C /var/lib/cezar/loki-labs/mw-site worktree remove "$W"
test -e "$W" && echo "STILL PRESENT: P3 FAILED" || echo "removed: ok"
git -C /var/lib/cezar/loki-labs/mw-site worktree list --porcelain | grep -c dc24830f   # want 0
```

The run's `diffStat` shows zero file changes, and the empty `status --short` is the check that
proves it on disk. Confirm zero changes **before** removing, not after. Verify both filesystem
absence and absence from `worktree list`: either one alone can pass while the other fails.

### P4. Constrain the probe to what it can answer

Add the §4 caveat to the probe's definition in the canary runbook: it selects a non-resident
target, and its output is **never** evidence about poller coverage, because `watchFile` creates no
inotify watch. State the positive evidence that *does* settle coverage: a pending intent written to
a cold project produces a run, which is what the twin tests and the production canaries assert.

Out of scope, and named rather than silently skipped: adding a headless todo-tombstone verb. It is
a real gap (it is why P2 is blocked) but it is a CLI surface change on a published package with its
own compatibility burden, and it belongs to its own task.

## Data Models

No schema changes. The two shapes this spec reasons about, both read from disk in this step:

**Todo record**, the fields that decide whether a todo can autostart:

```jsonc
{
  "id": "c2231b8c-85af-4869-8439-eea9f6442fb1",
  "summary": "COLD-WATCHER-CANARY-20260829T123220Z read-only: …",
  "status": "todo",
  // "autostart": true      ← ABSENT: consumed when the run started
  "startedTaskId": "dc24830f-6045-4d69-871c-6da692fc5448"  // ← makes `todo start` refuse it
}
```

`autostart` absent **and** `startedTaskId` present are independently sufficient to keep this todo
from re-firing (`todo-cli.ts:243`).

**Intent snapshots**, the poller's only view of a cold project:

```ts
// todo-autostart.ts
readTodoAutostartSnapshot(dataDir): Promise<{ items: Todo[]; pending: boolean; error?: Error }>

// reopen-watch.ts:42
readReopenIntentSnapshot(dataDir): Promise<{ requests: ReopenRequest[]; pending: boolean; error?: Error }>
```

Both resolve a missing file or a missing `.ai/cezar` to an empty, non-pending, side-effect-free
result. `pending` is the entire criterion-2 gate.

## API Contracts

Unchanged. Recorded because P1's closure note refers to them.

```ts
// packages/cezar/src/server/lazy-project-intents.ts
export interface LazyProjectIntentDiscovery {
  refresh(): Promise<void>;   // re-read the registry; called on boot and on workspace config change
  stop(): void;               // drop every watchFile, timer and listener
}

export interface LazyProjectIntentDiscoveryDeps {
  contexts: LazyProjectIntentContexts;
  loadProjects: () => Promise<readonly LazyProjectIntentProject[]>;  // pre-filtered by capability mode
  workspaceConfigPath: string;
  bootRoot: string;           // excluded from polling: it is always resident
  intervalMs?: number;        // default 5_000
}
```

Invariants a future change must not break, each already covered by a twin test:

- `contexts.context()` is called **only** from `inspect()`, **only** past the `pending` gate.
- The service is constructed **after** `createApp`, never inside it.
- No code path in this module calls `startWatch` or any `mkdir`.

**Missing contract, named honestly:** there is no headless verb to tombstone a todo. `cezar todo`
exposes `add`, `list`, `start` only.

## Risks

| # | Risk | Likelihood | Mitigation |
| --- | --- | --- | --- |
| 1 | **A future session re-implements the fix**, having read the ticket and not the code, producing a second discovery mechanism that races the first. | Medium, since the ticket text still reads as open work. | P1 exists for this. Both predecessor specs get a closure lead-in naming `809c8220` and this file. |
| 2 | **The probe reads false-green/false-red** and a canary "proves" a regression that is not there. | High if unaddressed: the probe already reports `0` for healthy cold projects. | P4. Until P4 lands, treat probe output as target-selection only. |
| 3 | **Hand-editing `mw-site/todos.json`** to clear the canary races the running server's lease and can drop a concurrent write. | Low, but the damage lands in a real project. | P2 forbids it explicitly: cockpit only. |
| 4 | "Just build all contexts at boot" is proposed as a simplification. | Low | Criterion 2 forbids it: a context build runs `pruneOrphans` + `RunManager` recovery. The twin tests fail if the pending gate is removed. |
| 5 | The canary todo is mistaken for a live autostart loop and treated as an incident. | Medium, since the handoff's stale text invites it. | Problem §3 Correction B: `autostart` absent, `startedTaskId` set, `todo start` refuses. |
| 6 | Closing on the cezar board alone leaves `mw-site` residue unnoticed. | Medium | Problem §3 Correction A pins the path. P2/P3 verification greps `mw-site` specifically. |

## Verification

### V1. The fix is present, merged and live (re-runnable, read-only)

```bash
cd /var/lib/cezar/loki-labs/cezar
git merge-base --is-ancestor 809c8220 origin/main; echo "merged=$?"     # want 0
LIVE=$(readlink /opt/cezar | sed 's/.*-//')
git merge-base --is-ancestor 809c8220 "$LIVE"; echo "live=$?"           # want 0
ls /opt/cezar/packages/cezar/dist/server/lazy-project-intents.js        # want: present
grep -c "contexts.context" /opt/cezar/packages/cezar/dist/server/lazy-project-intents.js  # want 1
systemctl show cezar.service -p ActiveState                             # want active
```

Recorded result, 2026-08-29: `merged=0`, `live=0` against `95b93175`, dist file present, count `1`,
`ActiveState=active` (started 14:03:47 UTC).

### V2. Both twin regression tests pass

```bash
cd /var/lib/cezar/loki-labs/cezar
npx vitest run packages/cezar/src/todo-autostart.test.ts packages/cezar/src/reopen-watch.test.ts
```

Both must pass, and specifically:

- `cold-project autostart discovery › boots the real server path and wakes a non-resident project
  only after a pending todo` (`todo-autostart.test.ts:230`)
- `cold-project reopen discovery › boots the real server path and wakes a non-resident project only
  after a pending request` (`reopen-watch.test.ts:226`)

Both assert the "only after" half, so they also cover criterion 2: a cold project with **no**
pending intent must not be woken.

### V3. Negative control for criterion 2, against the running system

Criterion 2 says a project with no pending flag must not have its context built. Establishing that
live takes **two** readings in the **same observation**, because neither one alone is sufficient:

**(a) No pending intent.** Read `mw-site`'s board:

```bash
node -e 'const t=require("/var/lib/cezar/loki-labs/mw-site/.ai/cezar/todos.json");
const a=Array.isArray(t)?t:(t.items||t.todos||[]);
console.log(a.map(x=>({id:String(x.id).slice(0,8),status:x.status,autostart:x.autostart})));'
```

Want: no entry with `autostart: true`. Recorded 2026-08-29: `de8eb687` and `c2231b8c`, both
`autostart: undefined`.

**This proves only that nothing is pending. It says nothing about whether a context was built** —
a context can be resident for a dozen unrelated reasons (any API touch, the boot root, a canary run
that already woke it), and the earlier draft of this section inferred non-residency from the absence
of `autostart: true`, which does not follow.

**(b) Demonstrated non-residency**, via the **corrected** `probe_inotify_dir` from
`.ai/specs/2026-08-25-cold-watcher-production-verification.md` § S2 (the original block in
`2026-08-25-lazy-project-watchers.md` compares `stat`'s `major<<8|minor` against fdinfo's
`major<<20|minor` and can never match). Run it with a **known-resident positive control in the same
invocation**:

```bash
pid=$(systemctl show cezar.service -p MainPID --value)
# paste probe_inotify_dir() from the S2 block of the verification spec
probe_inotify_dir resident-control /var/lib/cezar/loki-labs/cezar/.ai/cezar   # want matches >= 1
probe_inotify_dir mw-site          /var/lib/cezar/loki-labs/mw-site/.ai/cezar # want matches = 0
```

Acceptance: the control reports **at least one** match and `mw-site` reports **zero**, in that one
run. A run where the control reports zero is a broken probe, not a cold project, and the control
fails rather than passing (Problem §4, and the same rule the predecessor spec sets for target
selection).

**Only (a) and (b) together support the criterion-2 claim**: nothing was pending, and the project
is demonstrably still not resident. Note the direction of the inference — per Problem §4, a
`matches = 0` reading may be used to show non-**residency**, never to show absence of poller
**coverage**, because the poller uses `watchFile` and takes no inotify watch.

### V4. Criterion 3: no `.ai/cezar` conjured for a project that lacks one

Pick a registered project with no `.ai/cezar`, confirm the directory is still absent after at least
two poll intervals (default `5_000` ms):

```bash
test -e "<root>/.ai/cezar" && echo "CREATED: criterion 3 FAILED" || echo "absent: ok"
```

Static backing, re-read in this step. `reopen-requests.ts` calls `mkdirSync` in **two** places, not
one: `:116` in `acquireReopenLease` (the write-lease path) and `:327` in `startWatch` (the live
watcher). The safety property is therefore not "only `startWatch` creates the directory" — it is
that **lazy discovery reaches neither**. `lazy-project-intents.ts:4-5` imports exactly
`readTodoAutostartSnapshot` and `readReopenIntentSnapshot`; the latter (`reopen-watch.ts:42`) calls
`readReopenRequestsSnapshot` (`reopen-requests.ts:222`), which is the side-effect-free reader —
absent file returns `{ requests: [] }`, no `mkdir`, no lease, per that module's own "a read must not
materialize state" contract (`reopen-requests.ts:245-247`). Discovery reaches no lease or write path
(`acquireReopenLease`, `writeAtomic`) and no `startWatch`, so no `mkdirSync` call site is on its
path at all. The runtime absent-directory check above is the behavioural proof; this is only its
static backing.

### V5. Probe caveat (P4)

After P4, the runbook's probe section must state that `watched_matches=0` is the expected reading
for a healthy cold project. Verify by reading it back; there is no automated assertion for a doc.

### V6. Residue cleared (P2/P3)

```bash
node -e 'const t=require("/var/lib/cezar/loki-labs/mw-site/.ai/cezar/todos.json");
const a=Array.isArray(t)?t:(t.items||t.todos||[]);
console.log(a.filter(x=>String(x.id).startsWith("c2231b8c")).map(x=>x.status));'   # want [] or ["tombstoned"]
ls -d /var/lib/cezar/loki-labs/mw-site/.ai/cezar/worktrees/dc24830f-* 2>/dev/null || echo "worktree reaped"
```

**P2 will read red until the owner clicks it in the cockpit.** That is a park, not a failure, and
must be reported as such rather than rounded up.

### V7. Ownership gate (mandatory for any session touching the box)

```bash
find /var/lib/cezar -not -user cezar | wc -l   # must be 0
```

### What this spec does NOT claim

- I did **not** re-run the production canaries in this step. The end-to-end "cold project → run
  appears" claim rests on the execution record in
  `.ai/specs/2026-08-25-cold-watcher-production-verification.md` (mw-site autostart 4s, loki-labs
  reopen 6s, against `deploy.sha = 17637629`). What I verified independently is that the fix is
  merged, installed, and live in the currently running build, and that its pending gate survives in
  the shipped dist.
- I did **not** inspect the merge topology of `7a3a7879` versus `809c8220`/`e8a2b1d6`.
- I did **not** re-examine whether any newer CLI verb could tombstone a todo beyond reading
  `KNOWN_SUBCOMMANDS` at HEAD, which lists exactly `add`, `list`, `start`.
