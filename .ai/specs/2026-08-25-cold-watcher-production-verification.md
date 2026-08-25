# Cold Watcher Production Verification

> **Status:** Specified. The runtime fix this task describes is already merged to
> `origin/main`; what remains is closing three verification gaps, a manual deployment,
> and two production canaries. QA Needed until both cold paths pass on the running
> production service.
>
> **Task:** `abfcdb9c-e63b-4c0c-95c3-d331a86e39f7`. Board todo
> `f09bf585-f4fa-416f-a979-5bbd0dac22ed` carries this task's exact summary and is
> `in-progress`; its twin `503195a8-1f77-4ff5-b9b7-7a6606a5d639` is the reopen half.
> Both were read directly from `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json`.
>
> **Brief:** `.ai/specs/briefs/2026-08-25-lazy-watchers-prod-verify.md` (step 1 of this
> run). Every load-bearing claim in that brief was re-checked against the territory
> while writing this spec, and two of its conclusions are extended by measurements taken
> here (see Problem, sections 2 and 3).
>
> **Predecessor spec:** `.ai/specs/2026-08-25-lazy-project-watchers.md` (task
> `1f5aa96e-1254-4b78-a603-0307ff0fee94`, feature commit `809c8220`, merge `e8a2b1d6`).
> This spec does not replace it. It supersedes exactly one part of it, its production
> non-residency probe, and adds the test-rigor and deployment work its own execution
> record left open.
>
> **KB:** `notion-4feaf1dc57d8` ("Cold project intent discovery wakes both watchers"),
> `notion-c01d2be9d47a` (changelog twin). Both say **QA Needed**.
>
> **Naming note:** this repository has no `tools/next-spec` allocator (`ls tools/next-spec`
> → no such file; `scripts/` holds only `dev.mjs`, `release.mjs`, `release-snapshot.mjs`,
> `write-build-stamp.mjs`). 184 of the files in `.ai/specs/` use the date-plus-slug
> convention, which this file follows. No numeric id was inferred from a directory listing.

## TLDR

The defect in this task's title is real and was fixed three hours after this task was
filed, by a different run, in `809c8220` ("feat: implement lazy project watchers"),
merged as `e8a2b1d6` and now under `origin/main` tip `b5e9b4a8`. Re-implementing it
would duplicate working code.

Three things are nevertheless not done, and this task's acceptance criteria name all
three:

1. **This worktree cannot see the fix.** `cez/abfcdb9c` is based on `2fd01a16`, and
   `git merge-base --is-ancestor 809c8220 HEAD` answers no.
2. **The verification method the predecessor spec mandates is itself broken.** Its
   inotify residency probe compares two different kernel device encodings and therefore
   reports "not watched" for every path, including the boot project's own. Measured
   today against the live server it returns `matches=0` for the resident cezar data
   directory. Run as written, it would have manufactured a false proof of
   non-residency for the canary that is supposed to be the whole point.
3. **Neither twin regression test pins the wiring it claims to.** Each test's fake
   `contexts.context()` arms the live watcher itself, so deleting `server.ts`'s
   `contexts.onContextBuilt(...)` lines leaves both tests green. The predecessor's
   own source-removal control was never established either.

And production is not running the fix: `GET /api/v1/ready` reports
`deploy.sha = dc64b741…`, activated `2026-08-25T10:40:13.226Z`, while `809c8220` was
authored at `12:18:55Z`. Both deploy targets are `"manual": true`, so this chain parks
for a person rather than deploying.

So the scope here is: rebase onto the fix, correct the probe, make the two tests fail
for the right reason without the fix, run the gates, park for a human deploy, then run
the twin canaries against a project measured non-resident **after** that deploy's
restart, and sync the record. No runtime behaviour change is proposed.

## Problem

### 1. The shipped mechanism, re-read rather than assumed

`packages/cezar/src/server/lazy-project-intents.ts` (337 lines, new in `809c8220`) owns
one process-lifetime discovery service. It was read in full for this spec. Its shape:

- `watchFile(path, { persistent: false, interval })` on `<root>/.ai/cezar/todos.json`
  and `<root>/.ai/cezar/reopen-requests.json` for every registered, visible project
  whose normalized root differs from the boot root (`loadRows`), plus the workspace
  config path so late registrations enrol without a restart.
- `DEFAULT_INTERVAL_MS = 5_000`, `RETRY_BASE_MS = 250`, `RETRY_MAX_MS = 30_000`, no
  environment variable; `deps.intervalMs` is a test seam only.
- `inspect()` reads both snapshots in parallel through `readTodoAutostartSnapshot`
  (`todo-autostart.ts`) and `readReopenIntentSnapshot` (`reopen-watch.ts`), both added
  by the same commit as side-effect-free readers over `readTodosSnapshot` /
  `readReopenRequestsSnapshot`. Only when one of them reports `pending` does it call
  `deps.contexts.context(row.id)`, and only after `validateFreshIdentity()` re-reads the
  registry and re-checks id, normalized root and generation.
- `stop()` is called from `server.once('close', …)`.

`startServer` constructs it after `createApp` (`server.ts` diff of `809c8220`), with
`loadProjects: projectAccess.listVisibleProjects` — the capability-filtered loader that
the same commit hoisted out of `createApp` into `createProjectAccess`, so
`CEZ_SINGLE_PROJECT=1` still hides every non-boot row from discovery.

Acceptance criteria 1 to 3 of this task are satisfied by that code. Criterion 4 is
satisfied in letter (both suites gained a cold-project test) but not in substance, see
section 3. Criterion 5 is untouched, see sections 2 and 4.

### 2. The mandated non-residency probe cannot pass its own positive control

`.ai/specs/2026-08-25-lazy-project-watchers.md`, "Production runtime E2E", step 2,
supplies a `probe_inotify_dir` shell function and instructs the operator to accept the
proof only when a known-resident directory reports at least one match and the cold
target reports zero.

It derives the device with `stat -Lc %D "$path"`, which prints the **old** `dev_t`
encoding (`major << 8 | minor`). `/proc/<pid>/fdinfo/*` prints `sdev:` in the **new**
`kdev_t` encoding (`major << 20 | minor`). On this box the same device is `801` from
`stat` and `800001` in `fdinfo`. They can never be equal, so every comparison fails.

Measured 2026-08-25 against `cezar.service` `MainPID=2384818`:

```
# probe exactly as the predecessor spec writes it
cezar   path=/var/lib/cezar/loki-labs/cezar/.ai/cezar   dev=801  ino=a6702  matches=0
chat    path=/var/lib/cezar/loki-labs/chat/.ai/cezar    dev=801  ino=a6709  matches=0
```

`cezar` is the boot project of the running server. A probe that calls the boot project
cold is not a weak proof, it is an inverted one, and it fails silently in the direction
that makes a canary look valid.

With the encoding corrected (`dec=$((16#$(stat -Lc %D "$p")))`, then
`printf '%x' $(( ((dec>>8)<<20) | (dec & 255) ))`), the same probe against the same PID
separates the workspace cleanly:

```
cezar          matches=1     chat           matches=1
anymail-mcp    matches=1     lokie-chatbox  matches=1
homebrew-tap   matches=1     loki-labs      matches=1
bubble-trade   matches=0     aside          matches=0
career         matches=0     career-kit     matches=0
brand          matches=0     mw-site        matches=0
```

That is 6 resident and 6 genuinely non-resident projects out of the 13 rows in
`/var/lib/cezar/.cezar/config.json` (the thirteenth, `repo` at `/tmp/v7check/repo`, no
longer exists on disk and is a stale registry row, not a canary candidate). The process
holds one inotify fd (`fdinfo/25`) carrying 3221 watches, which is also the baseline for
the resource-delta measurement the predecessor spec asks for.

Note that `chat`, which the predecessor spec names as the preferred reopen canary
because the original inotify proof used it, is **resident right now**. Residency is a
property of this server generation, and the manual deploy restarts the service, so the
list above is evidence that the probe works, not a canary shortlist. It must be
re-measured after activation.

### 3. Both twin tests pass without the wiring they exist to prove

`packages/cezar/src/todo-autostart.test.ts:230` (`describe('cold-project autostart
discovery')`) and `packages/cezar/src/reopen-watch.test.ts:226` (`describe('cold-project
reopen discovery')`) both boot the real `startServer`, both assert `contexts.ids()` is
`[]` and `existsSync(targetDataDir) === false` before writing intent, and both then
assert exactly one build and one manager action. That much is genuine and satisfies the
letter of criterion 4.

But each test's stub `contexts.context()` does this, at
`todo-autostart.test.ts:282-288` and `reopen-watch.test.ts:276`:

```ts
for (const listener of listeners) listener(built);
stopTargetWatch = watchTodoAutostart({ repoRoot: targetRoot, dataDir: targetDataDir, … });
```

The second line arms the live watcher directly. `createApp`'s own hookups
(`server.ts:1760` for autostart, `server.ts:1776` for reopen) are therefore redundant
inside these tests: delete both lines and the tests still pass, because the stub does
their job. The ordering claim the predecessor spec makes in prose — that discovery is
started after `createApp` has registered both `onContextBuilt` callbacks, so a woken
context reaches reconciliation in the same turn — is not pinned by any assertion.

The predecessor's execution record concedes the related gap outright: *"The required
source-removal regression control was not established… no stash was created or popped,
and the implementation stayed present."* Taken together, nobody has yet seen either test
fail for the absence of the fix.

### 4. Production is not running the fix, and cannot be made to by this chain

```
$ curl -fsS http://127.0.0.1:4321/api/v1/ready
… "deploy":{"releaseId":"20260825T104007Z-dc64b741","version":"0.10.0",
   "sha":"dc64b741ceacee7208969e91039f98f5805eaf09",
   "activatedAt":"2026-08-25T10:40:13.226Z","builtAt":"2026-08-25T10:39:19.730Z","dirty":false}
```

`dc64b741` is the input-to-tasks commit that made this defect urgent, not the fix.
`809c8220` was authored at `12:18:55Z`, after that activation. Both entries in
`.ai/deploy-targets.json` are `"manual": true` by owner decision `c328ec06`
(`.ai/specs/2026-08-24-manual-deploy-not-a-bug.md`), each `manualReason` naming the
exact `server-deploy --strategy=blue-green` command and requiring deployment from the
run's own isolated worktree rather than the shared checkout. A red deploy step with a
manual handoff attached is a **park**, not a failure.

This is the one criterion an agent chain cannot close alone. The plan below therefore
ends in a documented, executable canary runbook handed to the owner, and this spec stays
QA Needed until the canaries actually run.

## Solution

Five changes, none of them to the discovery runtime.

### S1. Rebase onto the fix

Merge current `origin/main` into `cez/abfcdb9c` before touching anything. Without it the
tests below do not exist in this tree and the defect reads as unfixed for the wrong
reason.

### S2. Correct the residency probe, in place, in the predecessor spec

`.ai/specs/2026-08-25-lazy-project-watchers.md`'s `probe_inotify_dir` block gets a bolded
`CORRECTED 2026-08-25` lead-in, the corrected function, and the original text left below
it unchanged, per the workspace correction rule. The corrected derivation:

```sh
probe_inotify_dir() {
  label=$1; path=$2
  [ -e "$path" ] || { printf '%s path=%s ABSENT\n' "$label" "$path"; return; }
  dev_dec=$(( 16#$(stat -Lc %D "$path") ))          # stat prints major<<8 | minor
  sdev=$(printf '%x' $(( ((dev_dec >> 8) << 20) | (dev_dec & 255) )))  # fdinfo uses major<<20 | minor
  ino=$(printf '%x' "$(stat -Lc %i "$path")")
  matches=$(awk -v dev="$sdev" -v ino="$ino" '
    $1 == "inotify" {
      gd = gi = ""
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^sdev:/) gd = substr($i, 6)
        if ($i ~ /^ino:/)  gi = substr($i, 5)
      }
      if (tolower(gd) == tolower(dev) && tolower(gi) == tolower(ino)) print FILENAME ":" $0
    }
  ' /proc/"$pid"/fdinfo/* 2>/dev/null)
  printf '%s path=%s sdev=%s ino=%s matches=%s\n' \
    "$label" "$path" "$sdev" "$ino" "$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l)"
}
```

The acceptance rule is unchanged and now actually reachable: a known-resident control
must report at least one match in the same invocation in which the cold target reports
zero. A run in which the positive control reports zero is a broken probe, not a cold
project, and the canary does not proceed.

### S3. Make the twin tests fail without the wiring

Two edits, one per test file, each removing the stub's self-arming line so that the only
path from a discovered context to a live watcher is `createApp`'s `onContextBuilt`:

- `todo-autostart.test.ts`: drop `stopTargetWatch = watchTodoAutostart({…})` from inside
  the stub `context()`, keep `for (const listener of listeners) listener(built)`, and
  keep the `stopTargetWatch?.()` teardown by having the test capture the stop handle from
  the `onContextBuilt` path instead, or by relying on `server.close()`. The assertion set
  (`builds === 1`, `started.length === 1`, `startedTaskId` set, `autostart` cleared) is
  unchanged.
- `reopen-watch.test.ts`: the same removal of `stopTargetWatch = watchReopenRequests({…})`.

After this, deleting `server.ts:1760` or `server.ts:1776` must break the corresponding
test. That is the property S4 verifies.

### S4. Establish the source-removal control the predecessor could not

Do not stash the worktree; that is what failed last time. Use two surgical, reverted
patches applied and un-applied by `git apply`, so nothing depends on a clean tree:

```sh
git diff 2fd01a16..809c8220 -- packages/cezar/src/server/server.ts > /tmp/wiring.patch   # inspect, then
git apply -R --include=packages/cezar/src/server/server.ts …                             # or, simpler:
```

The simpler and sufficient form is a targeted edit: comment out only
`contexts.onContextBuilt((ctx) => watchTodoAutostart(…))` at `server.ts:1760`, run the
autostart test, capture the assertion failure, restore; then the same for
`server.ts:1776` and the reopen test. A third control removes
`void lazyProjectIntentDiscovery.refresh()` from `startServer` and must break **both**
tests. Every failure must be an assertion failure on `builds` or on the manager action.
An import error, a missing module, or a type error does not count and means the control
was mis-cut.

### S5. Deployment and canaries

Gates, then push the single commit to `origin`, then park at "Awaiting manual
deployment". After a person activates and `/api/v1/ready` reports the pushed sha, run the
twin canaries in Verification below, on projects measured non-resident **after** that
restart, using the corrected probe.

## Architecture

Nothing in the runtime ownership boundaries moves. Restated so a later reader does not
have to re-derive it:

```
cez todo start / cezar runs reopen   (CLI, writes an inert file, starts nothing)
              |
   <root>/.ai/cezar/{todos.json, reopen-requests.json}
              |
   lazy-project-intents.ts   watchFile poll, 5s, side-effect-free snapshots
              |  pending? and identity still valid?
              v
   ProjectContexts.context(id)  ---- the ONLY context builder
              |
     contexts.onContextBuilt  (server.ts:1760, 1776)   <-- what S3/S4 finally pin
        |                 |
  watchTodoAutostart   watchReopenRequests   -> manager.startRun / manager.continueRun
```

This spec adds nothing to that graph. It changes test wiring (S3), a verification
procedure inside another spec (S2), and the record (P6).

## Phases

Each phase is independently shippable and independently useful.

### P1. Rebase onto the fix

Merge `origin/main` into `cez/abfcdb9c`. Confirm
`git merge-base --is-ancestor 809c8220 HEAD` answers yes and that
`packages/cezar/src/server/lazy-project-intents.ts` exists in the worktree. No other
change. If the merge conflicts, resolve toward `origin/main` for every file the fix
touched.

### P2. Correct the probe

Apply S2 to `.ai/specs/2026-08-25-lazy-project-watchers.md` with the `CORRECTED
2026-08-25` lead-in and the original block preserved below it. Prove the corrected
function on the running server before writing it down: positive control ≥ 1, at least one
registered project 0, in one invocation. Ships alone; it fixes a booby-trapped runbook
whether or not the rest of this spec lands.

### P3. Test rigor

Apply S3, then S4. The deliverable is the two edited test files plus a captured record of
three assertion failures (autostart wiring removed, reopen wiring removed, discovery
refresh removed) and the restored tree passing again. Ships alone.

### P4. Gates and the one commit

```sh
npm run typecheck
npm run test:unit
npm run build
npm run test:package
npx vitest run packages/cezar/src/todo-autostart.test.ts packages/cezar/src/reopen-watch.test.ts
npm test
```

There is no root `lint` script (`package.json` has `typecheck`, `test`, `test:unit`,
`test:package`, `build`; no `lint`). Do not claim lint passed. The predecessor recorded
`npm test` as red in 5 unrelated suites with 15 failures on 2026-08-25; re-run it rather
than inheriting that claim, and if it is still red, name the five suites and show that
none of them is `todo-autostart`, `reopen-watch`, or `lazy-project-intents`. Commit once,
push to `origin` only, never `upstream`.

### P5. Manual deploy park, then the twin canaries

Park at the manual handoff. After a person deploys and `/api/v1/ready` carries this
HEAD, run both canaries in Verification. Neither canary may begin while the handoff is
unresolved or while the served sha predates the fix.

### P6. Record

In the same session as P5:

- Set board todos `f09bf585-f4fa-416f-a979-5bbd0dac22ed` and
  `503195a8-1f77-4ff5-b9b7-7a6606a5d639` to their true state, both together, since they
  are one root cause.
- Flip the predecessor spec's status line off QA Needed only if both canaries passed.
- Append the execution outcome to `CHANGELOG.md` and to the corpus at
  `/var/lib/cezar/loki-labs/notion-export/`, correcting KB entries
  `notion-4feaf1dc57d8` and `notion-c01d2be9d47a` in place rather than appending a second
  current-sounding note beside them.
- End with `cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb reindex`, then
  `grep -ac "<doc-slug>" /var/lib/cezar/loki-labs/.ai/cezar/knowledge-index/catalog.ndjson`
  returning 1. A corpus write is not a KB write until reindex; grep the slug or path,
  never the document's prose.
- End with `find /var/lib/cezar -not -user cezar | wc -l` returning 0.

## Data Models

No persisted model changes, and none are proposed.

- `todos.json` keeps `autostart`, `startedTaskId`, and tombstone semantics.
- `reopen-requests.json` keeps its `startedAt` and `error` terminal stamps.
- `~/.cezar/config.json` keeps the existing registry shape. Its stale `repo` row pointing
  at the deleted `/tmp/v7check/repo` is noted here as an observation only; removing it is
  out of scope and must not be bundled into this task's commit.
- No discovery cache, cursor, lock or marker file is introduced.

## API Contracts

No HTTP route, request, response, SSE event, CLI flag, exit code, workflow YAML, or agent
protocol change. `ServerDeps.projectAccess` and `ServerDeps.lazyProjectIntentIntervalMs`
already exist on `origin/main`; this spec adds no new exported surface. Compatible with
the published 0.x contract in `BACKWARD_COMPATIBILITY.md` because no input is rejected and
no emitted or persisted shape changes.

## Risks

- **Re-implementing what exists.** The largest risk in this task is a well-meaning
  session writing a second discovery mechanism because its branch is stale. P1 exists
  solely to remove that failure mode, and it is the first thing done.
- **A false-green canary.** The uncorrected probe reports every path cold. Any canary run
  before P2 proves nothing, in the exact direction that reads as success. Mitigation: the
  positive control is mandatory and in the same invocation.
- **Residency drifts under you.** `chat` is resident right now and was the original cold
  proof; a project's residency is per server generation, and the deploy restarts the
  service. Mitigation: re-measure after activation, and take the canary targets from that
  measurement, not from this document.
- **Test edits that weaken coverage.** Removing the stub's self-arming line could quietly
  turn a passing test into one that no longer exercises reconciliation at all. Mitigation:
  S4's three controls; each must fail on an assertion, and the restored tree must pass.
- **A canary that mutates a real project.** The reopen canary continues a real run.
  Mitigation: a read-only verdict prompt, a disposable todo for the autostart half, and
  mandatory cleanup with a re-query proving it.
- **Deploying from the shared checkout.** `.ai/deploy-targets.json`'s `manualReason` warns
  that `/var/lib/cezar/loki-labs/cezar` lags and that `server-deploy` builds what is
  checked out while `--sha` only labels the release. Mitigation: the runbook names this
  run's worktree path explicitly.
- **Root-owned corpus artifacts.** A record write over a `root@` session leaves files
  `cezar.service` can never read, and it still indexes, so it looks successful.
  Mitigation: the `find … -not -user cezar` gate in P6.

## Verification

No command in this section was run while writing this spec, except the read-only probes
quoted in Problem sections 2 and 4, which were run and whose output is reproduced there
verbatim.

### Automated

1. Focused twin regressions, which must pass on the rebased tree:

   ```sh
   npx vitest run packages/cezar/src/todo-autostart.test.ts packages/cezar/src/reopen-watch.test.ts
   ```

2. Source-removal controls, three runs, each capturing an assertion failure and then
   restoring the tree:

   | Removal | Expected failure |
   | --- | --- |
   | `server.ts:1760` `contexts.onContextBuilt((ctx) => watchTodoAutostart(…))` | `todo-autostart.test.ts` cold test fails on `started` length or on `startedTaskId` |
   | `server.ts:1776` `contexts.onContextBuilt((ctx) => watchReopenRequests(…))` | `reopen-watch.test.ts` cold test fails on the `continueRun` call list |
   | `startServer`'s `void lazyProjectIntentDiscovery.refresh()` | **both** cold tests fail on `builds === 1` |

   Any control that fails to compile, or fails on an import or a type, is mis-cut and does
   not count.

3. Repository gates as listed in P4. Record each result verbatim. Ask before running
   them, per the standing "don't build or run anything without asking" rule; the deploy
   command in particular is a person's to run here.

### Production, after a person deploys

Preconditions, all three:

```sh
curl -fsS http://127.0.0.1:4321/api/v1/ready | grep -o '"sha":"[0-9a-f]*"'   # equals this HEAD
pid=$(systemctl show cezar.service -p MainPID --value); echo "$pid"
grep -c '^inotify' /proc/"$pid"/fdinfo/*                                      # baseline; was 3221 pre-deploy
```

Then, with the **corrected** `probe_inotify_dir` from S2, run one invocation covering
`/var/lib/cezar/loki-labs/cezar/.ai/cezar` as the positive control and every registered
project's data directory. Record the full output. Accept only if the control is ≥ 1.
Choose two different projects reporting 0 — one for autostart, one for reopen — so the
first canary's context build cannot invalidate the second. As of the pre-deploy
measurement the candidates were `bubble-trade`, `aside`, `career`, `career-kit`, `brand`,
`mw-site`; re-derive the list post-restart rather than reusing that one.

**Autostart canary**

1. File a uniquely named disposable todo in the chosen cold project, without starting it.
2. `cez todo start <id> --project <project>`.
3. Poll once per second for at most 120 s. Record the elapsed seconds to the first state
   where that todo has a `startedTaskId`, no `autostart`, and exactly one matching run in
   the project's `runs.json`. The budget covers one 5 s discovery interval plus context
   recovery and manager launch.
4. On timeout, capture the todo, the probe output, and the run state, and fail the canary.
5. Cancel and delete the disposable run, tombstone the todo, re-query to prove cleanup.

**Reopen canary**

1. Pick one finished run with a resumable session in the second cold project. Record its
   id and current step count.
2. `cezar runs reopen --project <project>` with a prompt that asks for a read-only
   verdict and forbids repository mutation.
3. Same bounded 120 s, 1 s poll. Record elapsed seconds to the first state where the
   request carries `startedAt`, exactly one continuation step was appended, and the run is
   queued, running or waiting under that project's own manager.
4. Let it settle, record the verdict, confirm there is no duplicate continuation.

**Non-creation control.** Confirm that a registered project with no pending intent still
has no `.ai/cezar` directory after at least two discovery intervals, or, if every
registered project already has one, that the untouched cold projects' directories have no
new files and no new inotify watch. Discovery must never be the reason `.ai/cezar` comes
into existence.

**Close-out.** Record CPU and open-file counts and the `inotify` watch count before and
after both canaries, re-run the readiness probe, and re-run the residency probe to show
both canary projects are now resident and the untouched cold projects still are not.

This spec remains QA Needed if either canary was resident before its intent was written,
if only one of the twin paths was exercised, if the positive control ever read zero, or
if cleanup is incomplete.
