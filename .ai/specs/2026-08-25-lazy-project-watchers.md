# Lazy Project Watchers

> **Status:** Implemented, QA Needed until both cold-project paths pass on the
> production service.
>
> **Task:** `1f5aa96e-1254-4b78-a603-0307ff0fee94`, combining board todos
> `f09bf585-f4fa-416f-a979-5bbd0dac22ed` and
> `503195a8-1f77-4ff5-b9b7-7a6606a5d639` as one root cause.
>
> **Brief:** `.ai/specs/briefs/2026-08-25-lazy-project-watchers.md`, KB entry
> `specs-d1dfcc015a1f`. The brief's finding was re-checked against HEAD `2fd01a16` and the
> files and commits cited below. The board records were also read directly from the cezar
> project's `todos.json`.
>
> **Naming note:** this repository has no `tools/next-spec` allocator and its current convention
> is date plus slug, so this file follows that convention. No numeric spec id was inferred from a
> directory listing.

## TLDR

A registered project remains deliberately non-resident until an API request needs its
`ProjectContext`. Today that also means no process watches the project's `todos.json` or
`reopen-requests.json`. A later `cez todo start` or `cezar runs reopen` write therefore remains
pending forever unless an unrelated API request happens to build the context.

Add one server-owned cold-intent discovery service for both files. It observes the two intent
paths for every registered, non-resident project without creating either file or directory. On a
change, and once immediately at startup, it performs domain-level side-effect-free reads. Only a
project with at least one pending autostart todo or pending reopen request is passed to
`ProjectContexts.context()`. The existing `onContextBuilt` hooks then arm both live watchers and
their immediate reconciliation passes. Discovery for that project stops once the context is
resident.

No CLI, HTTP, JSON, workflow, or published event shape changes. Both defects are fixed together.

## Problem

### The same three clauses miss the same projects

`packages/cezar/src/server/server.ts:1734-1755` wires `watchTodoAutostart` and
`watchReopenRequests` with the same three clauses: the boot context, contexts already returned by
`contexts.ids()` and `contexts.peek(id)`, and future `contexts.onContextBuilt` callbacks.

That shape cannot name a cold registered project. `ProjectContexts` is intentionally lazy:
`packages/cezar/src/server/project-context.ts:246-251,303-320,367-375` keeps its map empty until
`context(projectId)` is called. Its regression test at
`packages/cezar/src/server/project-context.test.ts:88-104` proves an untouched project has no
context and no `.ai/cezar` directory.

The defect is still present at `2fd01a16`. The original watcher wiring landed in `4c0c0118`
(autostart) and `b99317c5` (reopen). Commit `dc64b741` made the autostart half urgent by shipping
the `input-to-tasks` dispatch step, but did not change either watcher.

### Pending intent is the only valid reason to wake a cold project

Building every context at boot is not a harmless way to obtain watches. A build opens the run and
automation stores, creates a manager and launch key, schedules orphan pruning and retention, then
calls `manager.recover()`: `packages/cezar/src/server/project-context.ts:409-496`. Recovery can
resume work. A context may therefore be built only after a side-effect-free inspection has found
pending intent for that project.

The two pending predicates already exist in domain terms:

- Autostart is `autostart === true`, no `startedTaskId`, and not tombstoned in
  `packages/cezar/src/todo-autostart.ts:521-559`.
- Reopen is neither `startedAt` nor `error`, through `isReopenPending`, in
  `packages/cezar/src/reopen-requests.ts:274-281` and
  `packages/cezar/src/reopen-watch.ts:70-99`.

The normal subscriptions cannot be used as discovery. Both
`packages/cezar/src/todos.ts:1084-1114` and
`packages/cezar/src/reopen-requests.ts:286-312` call `mkdirSync(dataDir, { recursive: true })`
when their first subscriber arrives. Subscribing every registered project would create
`.ai/cezar` in projects that have never used cezar, violating the zero-config read contract.

### User-visible failures

`cez todo start <id> --project <p>` deliberately does not start a run. It writes
`autostart: true` and leaves execution to the running cockpit, which owns the target manager,
workspace semaphore, and worktree lease. This is documented in
`packages/cezar/src/todo-cli.ts:229-240,299-310`, KB entry `specs-431b083f99d4`, and
`.ai/specs/2026-08-19-file-tasks-from-a-running-task.md:58-70,95-99`. The
`input-to-tasks` workflow now depends on that behavior across projects:
`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md:254-280,483-493`, shipped in
`dc64b741`. A cold project records the flag but creates no run.

Reopen uses the same ownership model. The CLI writes inert `reopen-requests.json`, and the target
cockpit calls its own `RunManager.continueRun`, as specified in
`.ai/specs/2026-08-20-reopen-finished-tasks-merge-audit.md:212-229,281-305`. Production execution
proved the gap with inotify against server PID `3683619`: workspace and cezar were watched, chat
was not. An authenticated API read made chat resident and was only a workaround. See KB entry
`specs-27e66a48ddd6` and
`.ai/specs/2026-08-20-reopen-sweep-execution.md:629-646,798-801,1051-1054,1085-1089`.

## Solution

### One cold-intent discovery service

Add `packages/cezar/src/server/lazy-project-intents.ts`. It owns one process-lifetime service,
started by `startServer` after `createApp` has attached both existing `onContextBuilt` callbacks.
Its dependencies are injected and narrow:

```ts
type LazyProjectIntentDiscoveryDeps = {
  contexts: ProjectContexts;
  /** Already filtered to the projects this server capability mode may expose. */
  loadProjects: () => Promise<Array<{ id: string; root: string }>>;
  workspaceConfigPath: string;
  bootRoot: string;
  intervalMs?: number;
};

type LazyProjectIntentDiscovery = {
  refresh(): Promise<void>;
  stop(): void;
};
```

The exact exported names may change during implementation, but the ownership and behavior may
not.

The capability-filtered loader at `packages/cezar/src/server/server.ts:1638-1644` is currently
only the default constructed inside `createApp`. It is not the production path: `startServer`
constructs `sharedContexts` with raw `listProjects` at
`packages/cezar/src/server/server.ts:7451-7464`, then injects those contexts into `createApp`.
`resolveBootProject` is also local to `createApp`, so `startServer` cannot call that closure.
Factor boot-project resolution and the capability-filtered project loader into a shared or
injected dependency that `startServer`, discovery, and lifecycle tests all use. Under
`CEZ_SINGLE_PROJECT=1` it calls `listProjects({ projectId: await resolveBootProject() })`;
otherwise it calls `listProjects()` without a selector. Production discovery must not use the raw
loader or reach into an inaccessible closure. The released single-project contract hides every
other registry row, so a hidden project with pending intent must remain unobserved and
non-resident. For every visible project whose normalized root is not the normalized boot root and
whose context is not resident, the service passively observes:

- `<root>/.ai/cezar/todos.json`
- `<root>/.ai/cezar/reopen-requests.json`

Use `fs.watchFile` with `persistent: false`. Unlike the existing live subscriptions, path stat
polling works when the file and its parent directories do not exist, uses no directory-creating
setup, and follows the path across the writers' atomic rename. Arm both observations before the
first inspection so a write cannot land between an initial read and subscription setup. Observe
the workspace config path the same way so projects registered by the HTTP route or another CLI
process join discovery without a server restart. A registry refresh removes observations for
unregistered or newly hidden projects. Resolve the boot root and each candidate root through the
registry's `normalizeRoot` identity before comparing them. Raw string equality is insufficient
for symlinked or otherwise alternate spellings of the same root and could open a second context
over the boot data directory.

Use one explicit five-second polling interval, with no environment variable. No latency target
exists in the record, so this spec does not invent a subsecond SLA or a user-facing knob. The live
workspace measured for this spec has 13 registered projects in
`/var/lib/cezar/.cezar/config.json`. With the resident cezar boot project excluded, that is 12
cold candidates and therefore 25 observed paths: two intent files per cold candidate plus the
workspace config, or about 5 stats per second. At 1,000 cold projects the same arithmetic is about
400 stats per second. Contexts that become resident immediately shed both intent observations, so
normal use is below the cold maximum. If production measurement later shows either latency or stat
load is wrong, change the constant from evidence rather than adding configuration.

Every callback routes through one per-project serialized inspection tail. The inspection reads
both files, not only the path that changed, then applies this decision:

```text
registered and non-resident project
              |
              v
  read autostart + reopen snapshots
              |
       any pending intent?
        |             |
       no            yes
        |             |
   remain cold   contexts.context(id)
                      |
                      v
             onContextBuilt fires
               |             |
        todo live watch   reopen live watch
               |             |
          immediate reconciliation passes
```

Concurrent file callbacks, registry refreshes, and a simultaneous API request may all ask for the
same project. The discovery tail coalesces its own work, and `ProjectContexts.context()` already
deduplicates in-flight builds. The two existing reconcile tails remain the final duplicate-start
guards. No new lock or cross-process lease is introduced.

Each registry refresh advances a discovery generation and records `{ id, normalizedRoot,
generation }` for every visible row. An inspection carries that identity, but pending intent at a
path is not sufficient by itself. Immediately before `contexts.context(id)`, first require the
active observation row still to have the inspection's id, normalized root, and generation. Then
reload through the same capability-filtered loader and require the freshly visible row to retain
that id and normalized root. Treat any difference as a new generation: discard the result and
refresh observations before another inspection. If the id was removed, hidden, or re-registered
at another root while the old-root read was pending, this prevents pending intent in the old root
from building the same id's new root, where no pending flag exists.

### Side-effect-free domain predicates

Do not duplicate todo or reopen parsing in the server helper. Export domain-level pending
inspection functions beside the existing reconcilers:

- `todo-autostart.ts` exposes a pure pending check using a new read-only snapshot helper in
  `todos.ts`. It must apply the same autostart, started-id, and tombstone predicate as
  reconciliation.
- `reopen-watch.ts` exposes a pure pending check that consumes the new error-bearing reopen
  snapshot and applies `isReopenPending` to successfully parsed rows. Cold discovery must not use
  `readReopenRequests`, because that general reader converts every read failure into an empty
  inbox. Existing live reconciliation may continue using it so its behavior does not change.

`readTodos` is not sufficient for the new pure contract because its legacy id-healing branch can
write and its broad read-error handling cannot carry discovery failures. The todo predicate must
likewise consume its new error-bearing, read-only snapshot, while existing reconciliation keeps
its current reader. The snapshot helper must use the existing parser without entering the healing
write path. Missing files return no pending intent. Malformed rows retain the existing per-row
warning and skip behavior. No inspection call may invoke `mkdir`, take a write lease, backfill an
id, or subscribe through `onTodosChanged` or `onReopenRequestsChanged`.

### Lifecycle and failures

`startServer` starts discovery after `createApp`, so a context built by discovery immediately
reaches both watcher callbacks. `server.once('close')` calls `stop()` alongside the automation and
backup cleanup already located there. `stop()` removes the workspace-config observation, both
intent observations for every cold project, and ignores later callbacks.

The discovery snapshots need error semantics that the current general readers do not have.
`packages/cezar/src/todos.ts:363-369` and
`packages/cezar/src/reopen-requests.ts:187-193` currently catch every `readFile` error and return
an empty inbox. Add discovery-specific, read-only snapshot results that classify only `ENOENT` and
`ENOTDIR` as absent and empty. Every other filesystem error is returned to discovery with its
source. Parsing keeps the existing malformed-file and malformed-row warning behavior, but the
snapshot never writes or subscribes.

Read the todo and reopen snapshots independently, including their error handling. An unreadable
`todos.json` must not prevent a valid pending reopen request from building the context, and an
unreadable `reopen-requests.json` must not hide pending autostart. Log each non-absence inspection
failure with project id and the exact `todos` or `reopen` source, then apply any successfully read
pending intent from the twin. A context build failure is likewise logged with project id and the
pending source or sources. Each transient snapshot or context-build failure schedules a
per-project exponential-backoff retry with jitter and a capped delay, continuing for as long as
the pending intent and project identity remain valid. Every retry re-reads both
snapshots, reloads the capability-filtered registry, and revalidates visibility, generation, and
normalized root immediately before any build. It does not depend on another `fs.watchFile`
callback, because an unchanged pending file does not produce another listener event. Cancel the
retry when pending intent disappears, the context becomes resident, the project becomes hidden or
unregistered, its root identity changes, or discovery stops. A missing root or missing
`.ai/cezar` is a normal no-pending result and emits no warning. Once a context is resident,
discovery removes its passive observations because the existing live watchers own all later
changes. The retry timer is process-local, uses `persistent: false`, and adds no persisted state or
configuration.

Operational observability is a structured one-line log when cold discovery finds pending intent
and requests a context build, including project id and `autostart`, `reopen`, or both. There is no
analytics event sink in this codebase, as already recorded in
`packages/cezar/src/todo-autostart.ts` and `packages/cezar/src/reopen-watch.ts`, so this change does
not invent a telemetry subsystem.

## Architecture

The ownership boundaries remain:

- `todos.ts` and `reopen-requests.ts` own file parsing and side-effect-free snapshots.
- `todo-autostart.ts` and `reopen-watch.ts` own pending predicates and reconciliation semantics.
- `server/lazy-project-intents.ts` owns cold registry discovery only. It never starts or continues
  a run itself.
- `ProjectContexts` remains the only context builder and keeps its existing in-flight build
  deduplication.
- `server.ts#createApp` keeps the two existing live watcher subscriptions. `startServer` owns the
  new service lifecycle because it owns the shared contexts and the real server close event.

The old mechanism remains load-bearing after the change. Discovery only wakes a cold context.
The `onContextBuilt` subscriptions still replace stale per-dataDir watches, perform immediate
reconciliation, serialize passes, and retain their existing cluster and capacity behavior.

## Phases

### P1. Pure pending inspection

Add side-effect-free todo snapshot reading and domain pending predicates for both intent types.
Pin missing directory, missing file, malformed row, terminal row, tombstoned todo, and genuinely
pending row behavior. This phase changes no runtime wiring and is independently safe to ship.

### P2. Shared cold discovery

Add the server-owned discovery service with registry refresh, passive file observations,
per-project serialization, context build deduplication, resident-project unsubscription, and
explicit teardown. Unit tests prove that only pending intent builds a context and that registering
a project after startup enrolls it. This phase is independently safe behind injected fake
contexts and temporary paths.

### P3. Wire both watcher paths

Start and stop discovery from `startServer`, after `createApp` has registered both existing live
watchers. Extend `packages/cezar/src/reopen-watch.test.ts` with the named cold-project regression
and add the twin regression in `packages/cezar/src/todo-autostart.test.ts`. Both tests begin with
`contexts.ids()` empty and assert the target context is still absent before writing pending
intent. This phase ships the user-visible fix.

### P4. Verify and record

Run targeted regressions and all repository gates, prove the regressions fail without the source
fix, then perform two production canaries against genuinely non-resident registered projects.
Update both board todos, the cezar changelog, and the curated corpus in the same session. The
feature remains QA Needed until production proves both paths.

Correct `/var/lib/cezar/loki-labs/notion-export/domains/cezar.md:43` in place. Its current
commit/push/deploy authorization contradicts the later manual-deploy decision. Add a bold
`CORRECTED 2026-08-25` lead-in that preserves commit and explicit `origin` push authorization,
marks only agent-run deployment as superseded by `c328ec06`, and leaves the original text below
unchanged. Add the durable twin-watcher decision and execution outcome to the corpus, then require
`CEZ_KB=1 cez kb search` to find both that correction and the watcher entry before claiming the
tracker, changelog, and knowledge record are synchronized.

## Data Models

No persisted model changes.

- `todos.json` keeps the released optional `autostart` and `startedTaskId` fields and tombstone
  semantics documented by `BACKWARD_COMPATIBILITY.md`.
- `reopen-requests.json` keeps its released `startedAt` and `error` terminal stamps.
- `~/.cezar/config.json` keeps the existing project registry shape.
- No discovery cache, cursor, lock, marker, or new `.ai/cezar` file is written.

The new dependency and return types are internal TypeScript shapes only. They are not exported as
an npm library surface.

## API Contracts

No HTTP route, request, response, SSE event, CLI flag, exit code, workflow YAML, or agent protocol
changes. Existing `cez todo start` and `cezar runs reopen` behavior becomes reliable for cold
registered projects. This is compatible with the public 0.x contract in
`BACKWARD_COMPATIBILITY.md:1-5` because no existing input is rejected and no persisted or emitted
shape changes.

No file under `packages/cezar/src` may spell the retired workspace name outside the fork package
specifier. The existing whole-tree test remains the enforcement mechanism.

## Risks

- **Accidental eager recovery.** Enumerating the registry and calling `contexts.context()` before
  proving pending intent would run recovery and pruning for every project. Tests must assert both
  context absence and filesystem absence for all non-pending controls.
- **Read that secretly writes.** Reusing `readTodos` can enter legacy id healing. The inspection
  API must remain a snapshot-only path, and a before/after filesystem assertion must pin it.
- **Half a fix.** Independent discovery implementations can drift. One service always reads both
  domain predicates and performs one context build decision.
- **Race between scan and observation.** Arm path observations before the first inspection. The
  existing context build and reconcile tails handle duplicate triggers after that.
- **Atomic rename and absent paths.** The intent writers replace files atomically and may create
  the full directory after server boot. Path-based stat observation is selected specifically so
  neither case requires an existing watched directory.
- **Background resource cost.** Cold cost is `2N + 1` stats every five seconds. The current
  measured `N = 12`; contexts shed observations when resident. The production runtime check must
  record CPU and open-file deltas before and after the canaries rather than treating green tests as
  a cost measurement.
- **External registry mutation.** Listening only to the in-process `project-added` bus would miss
  `cezar projects add` from another process. Observing workspace config and reconciling the full
  registered set closes both paths.
- **Shutdown leaks.** A persistent polling handle or forgotten callback would keep tests or the
  server alive. Every watch uses `persistent: false`, and the close-path test asserts `stop()`
  removes all observations.
- **Production false positive.** A canary against a project already made resident by an API read
  proves only the old path. Non-residency must be established before each intent write.

## Verification

No command in this section was run while writing the spec.

### Execution record, 2026-08-25

The implementation landed on `origin/main` in merge commit `e8a2b1d6`, with feature commit
`809c8220`. The focused watcher tests passed: 2 files and 51 tests. Typecheck, `test:unit` with
44 tests, build, and `test:package` with 25 tests also passed. The full `npm test` gate remains
red in 5 unrelated suites with 15 failures. There is no root lint script.

The required source-removal regression control was not established. The clean-control stash could
not run because existing intent-to-add paths were not stashable, no stash was created or popped,
and the implementation stayed present. The targeted control that was run passed 40 of 40 tests,
so it does not prove the unfixed behavior fails.

The mandatory production canaries were not run. No production project was used, no non-residency
proof was recorded, and the manual deployment handoff remains unresolved. The spec therefore
stays QA Needed.

### Automated regression

1. Run the focused tests:

   ```sh
   npx vitest run packages/cezar/src/reopen-watch.test.ts packages/cezar/src/todo-autostart.test.ts packages/cezar/src/server/lazy-project-intents.test.ts
   ```

   The two primary cold-path regressions must boot the real `startServer` lifecycle on an ephemeral
   port with an injected registry and injected `ProjectContexts`. They must not construct only the
   discovery helper, because that would not prove `startServer` starts it after both
   `onContextBuilt` subscriptions. Before each intent write, assert the registered target is absent
   from `contexts.ids()`. Through the server-owned discovery service, the reopen regression then
   writes one pending request, observes exactly one context build and one `continueRun`, and
   observes its terminal stamp. Its autostart twin writes one pending todo, observes exactly one
   context build and one `startRun`, then observes `startedTaskId` with `autostart` cleared. Close
   the real HTTP server and prove later registry or intent writes cause no inspection or context
   build. Direct helper tests remain useful additional unit coverage, not substitutes for these
   lifecycle regressions.

2. In both test homes, add negative controls that never build a context:

   - project with no `.ai/cezar`, whose directory remains absent after multiple discovery polls;
   - existing empty intent file;
   - todo without autostart, already-started todo, and tombstoned autostart todo;
   - reopen row carrying `startedAt` or `error`;
   - malformed or inaccessible state in one project while another healthy project still wakes;
   - project added to the registry after discovery starts;
   - delayed old-root inspection while the project id is removed or re-registered at a different
     root; the stale result is discarded and neither replacement context nor old root is acted on;
   - under `CEZ_SINGLE_PROJECT=1`, a hidden registry project with pending intent remains
     unobserved, absent from `contexts.ids()`, and unchanged on disk;
   - a boot-root row using an alternate path spelling is excluded by normalized identity;
   - both pending files in one project, producing one deduplicated context build and both
     reconciliations;
   - a pending file whose first `contexts.context()` attempt fails and whose retry succeeds without
     any second intent write or registry write.

3. Prove the regression tests fail without the fix behaviorally. Temporarily revert only the
   runtime discovery wiring while retaining every new helper, export, module, and test dependency,
   then run the focused command. Both real-`startServer` cold-path tests must compile and fail on
   their context-build or manager-action assertions. An import, missing-module, or type failure
   does not count. Restore the runtime wiring after capturing the two assertion failures. Do not
   use the full worktree stash.

### Repository gates

Ask before executing commands, then run and record every result:

```sh
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

There is no root lint script. Do not claim lint passed. The build must be fresh before deployment
because the blue-green deploy rejects a stale build stamp.

### Mandatory human deployment

Both targets in `.ai/deploy-targets.json` are `"manual": true`, by owner decision `c328ec06` and
`.ai/specs/2026-08-24-manual-deploy-not-a-bug.md`. An agent-run deploy must park at "Awaiting
manual deployment". That is the expected handoff, and production canaries must not begin while the
new commit is merely pushed or while that handoff remains unresolved.

After all gates are green and the one feature commit is pushed to `origin`, a person deploys from
this run's isolated worktree, never the shared checkout:

```sh
cd /var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/1f5aa96e-1254-4b78-a603-0307ff0fee94
npm ci
npm run build
node /opt/cezar/packages/cezar/dist/index.js server-deploy --strategy=blue-green --source="$PWD" --sha="$(git rev-parse HEAD)"
```

The person must then run `curl -fsS http://127.0.0.1:4321/api/v1/ready`, verify `ready` is true
and `deploy.sha` equals the pushed worktree HEAD, and only then press Resolve on the manual deploy
handoff. Production E2E begins only after activation and the served SHA are verified. Record the
deployed SHA, release id, readiness response, and handoff resolution in the execution log.

### Production runtime E2E

Use two registered projects after a fresh production restart, or restart between canaries if one
project is reused. The execution record must state the exact project ids. `chat` is the preferred
reopen canary because it is the project used by the original inotify proof and has finished runs;
choose another registered project for autostart so the first context build cannot invalidate the
second test.

Before each write, establish non-residency from the server process, not from the UI:

1. Record the deployed release sha and server PID.
2. Run the following probe with a known resident data directory as the positive control and the
   proposed cold target as the negative control. It derives the service PID, converts each
   directory's device and inode to the hexadecimal representation used by inotify fdinfo, and
   scans every inotify descriptor owned by that process:

   ```sh
   resident_dir=/var/lib/cezar/loki-labs/cezar/.ai/cezar
   cold_dir=/var/lib/cezar/loki-labs/chat/.ai/cezar
   pid=$(systemctl show cezar.service -p MainPID --value)
   probe_inotify_dir() {
     label=$1
     path=$2
     dev_hex=$(stat -Lc %D "$path")
     ino_hex=$(printf '%x' "$(stat -Lc %i "$path")")
     matches=$(awk -v dev="$dev_hex" -v ino="$ino_hex" '
       $1 == "inotify" {
         got_dev = got_ino = ""
         for (i = 1; i <= NF; i++) {
           if ($i ~ /^sdev:/) { got_dev = substr($i, 6) }
           if ($i ~ /^ino:/)  { got_ino = substr($i, 5) }
         }
         if (tolower(got_dev) == tolower(dev) && tolower(got_ino) == tolower(ino)) {
           print FILENAME ":" $0
         }
       }
     ' /proc/"$pid"/fdinfo/* 2>/dev/null)
     printf '%s path=%s dev=%s ino=%s matches=%s\n' \
       "$label" "$path" "$dev_hex" "$ino_hex" "$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l)"
     printf '%s\n' "$matches"
   }
   probe_inotify_dir resident "$resident_dir"
   probe_inotify_dir cold "$cold_dir"
   ```

   Record the command and output. Accept the proof only when the resident control reports at least
   one matching inotify entry and the cold target reports zero. If either directory is absent,
   choose an existing registered target for this probe. If the positive control is zero or the
   cold target is nonzero, non-residency is not established and the canary remains QA Needed. Do
   not add a production context-listing hook and do not touch a project-scoped API route first.
3. Confirm the project is present in `~/.cezar/config.json` and its pending file is absent or
   terminal before the canary.

For the filesystem non-creation control, first select a registered, visible project whose
`<root>/.ai/cezar` does not exist. If every current project already has state, create a temporary
git repository under the configured browse root, register it through the supported project-add
surface, and record its project id and root. Do not touch a project-scoped route for it. Establish
that it is non-resident through the server-process check above and that `.ai/cezar` is absent,
leave it pending-free through at least two discovery intervals, then confirm the directory is
still absent. Remove the registry entry and temporary repository through supported surfaces after
the canaries.

Autostart canary:

1. File a uniquely named disposable todo in the selected cold project without starting it.
2. Run `cez todo start <id> --project <project>`.
3. Start a bounded 120-second poll immediately after the command, sampling once per second. Record
   the elapsed time to the first state where the same todo has a `startedTaskId`, no `autostart`,
   and exactly one corresponding run in that project's `runs.json` and cockpit stream. The budget
   includes one five-second discovery interval, context recovery, and manager launch work. On
   timeout, capture the last todo, context, and run state and fail the canary.
4. Cancel and delete the disposable run and tombstone the todo through project-scoped supported
   surfaces. Re-query to prove cleanup.

Reopen canary:

1. Select one finished run with a resumable session in cold `chat`, recording its id and current
   step count.
2. Append one reopen request through `cezar runs reopen --project chat` with a canary prompt that
   asks for a read-only verdict and no repository mutation.
3. Start the same bounded 120-second, one-second poll immediately after the command. Record the
   elapsed time to the first state where the request has `startedAt`, exactly one continuation step
   was appended, and the run is queued, running, or waiting through chat's own manager. On timeout,
   capture the last request, context, step, and run state and fail the canary.
4. Let the canary settle, record its verdict, and verify there is no duplicate continuation.

Finally record the process CPU and open-file counts before and after both canaries, confirm the
project that never had `.ai/cezar` still does not have it, and confirm both service readiness
probes are green. The spec remains QA Needed if either canary was resident before its intent was
written, if cleanup is incomplete, or if only one of the twin paths was exercised.
