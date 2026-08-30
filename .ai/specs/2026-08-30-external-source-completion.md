# External Source Completion

**Status:** Implemented, QA Needed
**Program:** central hub
**Extends:** `.ai/specs/2026-08-06-external-source-connectors-notion.md` (F2)
**Record:** KB `notion-003426d0cf3f`, KB `notion-76ae9455721e`, KB `notion-711b57ca383e`

> **Naming note:** this repository has no `tools/next-spec` allocator. The original central-hub
> PLAN records that date plus slug is the whole identity
> (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md:118`), and recent specs use that convention.
> `tools/next-spec` was checked before this file was created and returned exit 127 because the
> path does not exist. This file therefore claims its date-slug path directly.

## TLDR

The central-hub knowledge store, source-provider seam, Notion client, resumable source sweep,
notes pipeline, and cross-project views are already on `origin/main`. Commit `65eef6d2` landed the
Phase 1 source files, and commits `94b62452`, `75f6abaa`, `80c7ee36`, `63de653c`, and `11467f44`
landed the later workspace surfaces. The historical task is wrong where it still describes those
changes as uncommitted.

One important F2 gap remains in current code. `sources/sync.ts`, `coordinator.ts`, and
`scheduler.ts` exist and have focused tests, but nothing constructs the source scheduler in the
server. `POST /sources/:connectionId/sync` and conflict resolution deliberately return 409
"not available yet", the comments route deliberately returns an empty list, and the cockpit's
Add source and Sync now buttons deliberately throw a local "not wired up yet" error. The external
source feature is a browsable scaffold, not a working mirror.

Complete that existing vertical slice. Use one workspace source runtime and one `SourceStore`
instance per project, wire scheduled and manual sync through the existing `SourceProvider` and
`SourceSink` contracts, persist the already-designed comment stream, implement the two published
conflict actions, and replace the cockpit stubs with typed client mutations and an honest document
and conflict view. Keep every published route and response shape. With `CEZ_SOURCES` unset, do no
source I/O, construct no provider, arm no timer, render no source navigation, and keep health and
the agent system prompt byte-identical under an injected clock.

## Problem

### 1. The programme record is stale, but the source feature is still incomplete

The task document says Phase 1 is uncommitted and ungated (KB `notion-003426d0cf3f`, corpus path
`tasks/3b4b9863-cezar-as-the-central-hub-knowledge-base-external-sources-not.md`). Git history
contradicts it: `65eef6d2` is an ancestor of `origin/main` and contains the knowledge, source,
notes, notification, contract, API, and cockpit source files. The old
`origin/feat/knowledge-base-central-hub` branch contains no unique commit. This spec does not
revive that branch or build a second knowledge system.

The current implementation itself names what did not finish:

- `packages/cezar/src/server/sources-routes.ts:40-43` says the sync engine is not wired.
- `POST /sources/:connectionId/sync` returns `SYNC_ENGINE_PENDING` at
  `packages/cezar/src/server/sources-routes.ts:327-328`.
- conflict resolution returns `RESOLVE_ENGINE_PENDING` at
  `packages/cezar/src/server/sources-routes.ts:393-397`.
- the comments route always returns `EMPTY_SOURCE_COMMENTS` at
  `packages/cezar/src/server/sources-routes.ts:401-407`.
- `WorkspaceSourceScheduler` says nothing wires it into boot at
  `packages/cezar/src/sources/scheduler.ts:23-28`, and no production construction site exists.
- `packages/web/src/routes/settings/sources-section.tsx:37-50` records that Add source and Sync
  now have no typed mutation wrapper. Both actions call `unwiredSourceMutation`.

This is not a request to redesign F2. The original authority already chose a generic registry-keyed
`SourceProvider`, an F1-mounted file mirror, no remote writes, one watcher, and exact opt-in flags
(`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D3-D8 and D15-D19;
`.ai/specs/2026-08-06-external-source-connectors-notion.md` Q1-Q17). The missing work is the
runtime and user path that connect the already-landed pieces.

### 2. Separate store instances would make a correct scheduler stale

`activateOptionalStores` currently opens a `SourceStore` for every resident `ProjectContext`
(`packages/cezar/src/server/project-context.ts:118-129`). `SourceCoordinator` independently caches
stores opened from the same files (`packages/cezar/src/sources/coordinator.ts:29-79`). Wiring the
scheduler without reconciling those construction sites would give the HTTP routes and the timer
two in-memory snapshots of `sources.json` and `source-state.json`. A connection created through the
API could be invisible to the scheduler until restart, while a completed sweep could be invisible
to a route. The automation runtime already avoids this class by injecting its coordinator-owned
store into contexts (`packages/cezar/src/server/server.ts:7934-7979`). Sources need the same
single-instance guarantee.

### 3. The published API promises behavior the server does not perform

The routes are already a documented compatibility surface
(`BACKWARD_COMPATIBILITY.md:117`). The contract already says:

- manual sync answers `202 {syncId}`;
- conflict resolution accepts exactly `keep-local` or `take-remote`;
- comments return a typed stream;
- source documents carry stored provenance and sync state.

Changing those schemas is unnecessary and would widen the task. The work is to make the source of
the response match the contract. In particular, `GET` bodies must remain clock-free. Freshness is
the stored `syncState`, `syncStateAt`, `mirroredAt`, and `lastCompleteSweepAt` model from F2 Q6,
not an `ageMs` field derived in a handler.

### 4. The motivating pagination failure remains a release gate

F2 was designed around a recorded failure where the only matching Notion row was on page 2 and a
first-page-only reader reported emptiness for about 45 ticks
(`.ai/specs/2026-08-06-external-source-connectors-notion.md:13,45`). The current Notion client has
recorded page fixtures and pagination tests. Runtime wiring must not bypass that client, call raw
`fetch` from a route, or infer deletion from one partial page. The existing
`SourceChangePage.complete` and persisted `pageCursor` remain the only authority for exhaustion.

## Solution

### S1. One source runtime owns coordination, scheduling, and manual kicks

Add a small `SourceRuntime` in the existing `sources/` domain. It owns one `SourceCoordinator`, one
`WorkspaceSourceScheduler`, one execution queue per project, the same-connection join map, and the
lifecycle methods `start`, `stop`, `reschedule`, and `kick`.

The runtime is constructed only when `resolveCapabilities(...).sources` is true. When the exact
flag is off, `startServer` does not construct it, no coordinator refresh runs, no provider resolves,
and no timer exists. This is the behavioral gate, not only a route gate.

`SourceRuntime.store(projectId, root)` is the only production construction path for a project's
`SourceStore`. `ProjectContexts` receives a source-store factory, just as it already receives the
automation-store factory. The boot context and lazy contexts both use the runtime-owned instance.
Tests that construct contexts without a runtime keep the current fallback behavior.

Coordinator discovery always includes the boot project explicitly. The registry loader may omit an
unregistered boot root, while `SourceCoordinator.refresh()` removes every cached store absent from
the supplied list. The runtime therefore prepends `{id: bootProjectId, root: repoRoot, status:
'ok'}` unless an entry with that id or resolved root is already present. A refresh can never evict
the boot project's source store merely because the operator has not registered that root.

Manual kicks and due ticks use the same project-level execution queue. This matches the existing
lease, `<dataDir>/sources-poll.lock`, which protects the whole project rather than one connection.
Only one connection attempt per project may enter `runSourceSync` at a time, whether it came from a
timer or HTTP. `kick(projectId, connectionId)` returns a random `syncId` immediately and runs off
the HTTP request path. A second kick for the same connection joins the queued or active item and
returns the same `syncId`. A different connection joins the same project queue with its own id.
A due tick and a manual kick are ordered by that queue, never raced against the shared lease.

The in-process queue is not authority over another cezar process. If `runSourceSync` reports that
the project-wide lease is held, the queued item retains its `syncId` and retries with bounded
backoff until it acquires the lease or server shutdown cancels the process-local waiter. It does
not settle as a successful no-op. The existing ten-minute stale-lock reclaim remains the outer
bound on an abandoned owner. Completion clears the connection join entry and reschedules from the
stored `nextDueAt`.

Today `ran: false` conflates a held lease with disabled, archived, and backed-off connections.
Extend the internal `SourceSyncResult` with a closed no-run reason
`lease-held | disabled | archived | backoff`. Only `lease-held` remains queued and retries. The
other three are intentional no-runs and settle without a retry loop. This discriminator is not an
HTTP field and does not change a published response.

One store object is only a within-process guarantee. `SourceStore` caches definitions, state, and
append-log sequence in memory, so a second cezar process can make that cache stale even when the
project-wide poll lease correctly serializes sweeps. Add a short project store lock, separate from
`sources-poll.lock`, for every durable read-modify-write. Under that lock the operation reloads the
relevant file from disk, merges against the fresh value, atomically replaces or appends it, and
refreshes the caller's in-memory snapshot before releasing. This covers connection CRUD, state,
adopted/tombstone sets, source-log sequence, comment sequence, and comment compaction. Lock order
is always poll lease first, then the short store lock, and the store lock is never held across a
provider or filesystem-mirror call.

After acquiring `sources-poll.lock`, a queued sync reloads the connection definition, its
`SourceState`, source-log sequence, and comment sequence from disk before it decides whether the
connection may run or selects a cursor. `runSourceSync` therefore receives a connection id and
loads the current connection after the lease, rather than trusting the object captured when the
queue item was created. Cross-process lease handoff cannot run with stale enablement, revision,
watermark, cursor, or sequence state, and concurrent CRUD cannot overwrite a sibling process's
newer definition.

### S2. Every sync uses the existing provider, sweep, and F1 sink boundary

The runtime resolves providers only through `resolveSourceProvider(connection)`. It never imports
Notion into the server and never consults a git remote. It invokes `runSourceSync`, which retains
the lease, resumable cursor, diff-before-fetch, explicit tombstone, quarantine, backoff, and
`notifyChanged` behavior already covered in `packages/cezar/src/sources/sync.test.ts`.

One document-enumeration request budget belongs to the whole connection tick. `SourceChangePage`
adds internal `callsUsed` plus an optional provider retry delay. `runSourceSync` starts with the
connection budget, passes only the remainder to each collection, subtracts the returned
`callsUsed`, and persists the current collection cursor as soon as the remainder reaches zero. A
later collection never starts with a reset budget. A provider that omits `callsUsed` is charged the
full allowance it received, which fails closed for an older implementation.

Notion's `Retry-After` must survive the client, provider, and sweep seams. On 429 or a provider
page carrying a retry delay, `backoffUntil` is never earlier than that lower bound. Jitter is drawn
between the provider lower bound and the existing exponential ceiling; if the provider lower bound
exceeds the normal six-hour ceiling, the lower bound wins. This retains bounded exponential jitter
for ordinary failures without retrying before the remote service permits it.

For a resident project with `CEZ_KB=1`, the handle wraps `FileSourceSink` through
`knowledgeStore.createSourceSink(...)`, so the required F1 `notifyChanged(root, docIds?)` call
reaches the live index (`packages/cezar/src/knowledge/store.ts:622-652`). For a non-resident project
or with knowledge disabled, it uses `FileSourceSink` directly. The bytes are still correct and the
next F1 initialization indexes them. A scheduled read does not construct a project context and
therefore cannot recover or resume agent runs.

Create, update, delete, adopt, resolve, and completed sync all call `runtime.reschedule()` or the
narrower equivalent after the durable write. Project-added and project-removed workspace events
refresh the coordinator. Server close always stops the scheduler.

### S3. Make all existing source routes truthful

`SourcesRouteDeps` becomes a real dependency object with `kick`, `reschedule`, and an optional
clock/id seam for tests. The route family remains chained exactly where it is now.

- `POST /sources/:connectionId/sync` validates flag, connection, mode, and provider, calls
  `kick`, and returns the already-published `202 {syncId}`. Disabled, archived, or currently
  unavailable connections return a truthful 409 and no id. The cockpit disables Sync now for the
  same three stored/availability states.
- create, update, and delete keep their existing wire responses, then notify the runtime after the
  store write. Creating disabled, disabling, or archiving persists `syncState: paused` and
  `syncStateAt` in the same durable operation. Re-enabling clears the paused schedule by writing
  `nextDueAt` as immediately due, then reschedules.
- `GET /sources/:connectionId/collections` is explicitly the connection's configured collection
  list, not workspace discovery. The current Notion provider can resolve only the collection ids
  already present on the connection, and the response contract has no cursor with which to expose
  a bounded remote search. Update the contract comment, compatibility inventory, and cockpit copy
  to say "Configured collections". Each row may carry a provider-resolved label or document count,
  but unavailable providers return the configured ids without enrichment. The connection editor
  accepts explicit collection id plus collection kind. General Notion collection discovery is a
  separate additive route with a paginated contract if it is later measured and requested.
- `GET /sources/:connectionId/comments` reads the persisted stream for that connection.
- conflict resolution implements the two contract actions described below.
- all flag-off `GET` and mutator responses remain exactly as F2 D19 specifies.

No new public route is needed. Retain F2's `source-sync` workspace SSE decision. Every scheduled
and manual outcome emits through `WorkspaceEventBus` after its stored state commits, carrying at
least `{project, connectionId, revision, syncState}`. The existing global workspace-event listener
invalidates only that project's source list, document, comment, and log query keys. Bounded polling
of the existing `GET /sources` remains reconciliation for a missed event or process restart, not
the sole live update mechanism. The `syncId` is an acceptance id, not a second job database.

### S4. Persist and sweep comments without changing document bodies

Implement the already-specified `source-comments.ndjson` stream in `SourceStore`. A stored row
contains the public comment fields plus `seq` and `connectionId`. Append is idempotent on
`(connectionId, external comment id)` and reads are stable by `seq`. Compaction is not the
`source-log.ndjson` truncation policy: it rewrites one canonical retained row per
`(connectionId, id)` and preserves every unique comment. Removing old ids would both remove them
from the public stream and permit the provider to append them again. No age or count retention is
introduced without a measured corpus size and a separately documented policy.

Comments run only when all three facts are true: the connection has `watchComments`, the provider
declares `capabilities.comments`, and `listComments` exists. Documents are ordered by the oldest
stored comment sweep first. One shared per-connection comment request budget is created for the
tick and decremented for every remote comment page across every document. The provider method keeps
its current optional `since` argument and adds one optional input
`{cursor?: string, callBudget?: number}`. The Notion implementation passes both values into
`listPageComments`, returns the actual request count consumed as optional `callsUsed` on
`SourceCommentPage`, and stops before the shared remainder reaches zero. A provider omitting
`callsUsed` is conservatively charged the full budget it received, so an older implementation
cannot overrun the shared ceiling. Starting N documents cannot multiply the budget by N. Existing
providers remain method-call compatible because the new input is optional.

A comment watermark advances only after that document's comment enumeration reaches
`complete: true`. A partial page persists its cursor and advances neither the watermark nor the
document's completion marker. The next document receives only the unspent remainder. Attachments
remain `{type, downloadable:false}` where bytes cannot be read, as required by F2 Q17. Comments
never enter mirrored Markdown bodies, so an out-of-band reply cannot manufacture a document
conflict.

### S5. Resolve conflicts without remote writes or silent loss

Both actions first obtain a current `SourceDocumentRef` through the provider's bounded,
cursor-following enumeration from a null watermark for the document's configured collection. This
is a read-only lookup and does not advance the connection's persisted sweep watermark.
`fetchDocument(ref)` is
not a metadata refresh: the current Notion implementation returns `{...ref}` and would preserve a
stale `remoteVersion` supplied by the quarantined document. Resolution must therefore locate the
matching `externalId` in a complete enumeration, then pass that newly returned ref to
`fetchDocument` and persist that ref's version. If the budget is exhausted, enumeration is partial,
the provider is unavailable, the external id is absent, or the body cannot be fetched, resolution
answers 409 with the stored/provider reason and changes nothing.

- `keep-local`: preserve the current local body byte-for-byte, keep the quarantined remote body,
  advance `remoteVersionSeen` and `source.remoteVersion` to the newly enumerated remote version,
  and set `source.state` to `ok`. `localVersion` remains the same SHA-256 because the body bytes
  are unchanged. This prevents the same remote version from re-firing the conflict.
- `take-remote`: first copy the current local body to
  `conflicts/<docId>.local-<shortLocalVersion>.md`, then write the fetched remote body and metadata
  as the live document with `state: ok`. The local evidence is moved aside before replacement.

If the remote advances again between quarantine and resolution, the newly enumerated version wins;
the stale quarantined version remains as evidence but is never written live by accident.

Both paths update stored conflict counts, append a source log row naming the action, call F1's
change notification, and return the existing `ResolveSourceConflictResponse`. There is no merge,
remote update, or remote delete.

### S6. Replace the cockpit stubs with the typed workflow

Add typed api-client functions and query mutations for connection create/update/delete, manual
sync, adopt, and resolve. The existing Add source and Sync now buttons call those functions,
invalidate the source queries on success, and show server errors verbatim.

The connection dialog becomes a usable editor rather than a name-only request. Create and edit
both expose provider kind, connection name, enabled state, mode, interval, watch-comments state,
and at least one explicit configured collection row containing collection id and collection kind.
Creation is disabled until a syntactically valid collection row exists. The default enabled state
is deliberate and visible: new connections are enabled on create, so the first Sync now can do
work. Editing can disable or archive a connection, add or remove configured collections with the
existing revision check, and delete requires confirmation. Credentials remain environment-only.

Expand the project-scoped Sources section in place:

- a connection row can open its mirrored document list;
- a document opens a body preview with provenance and lossiness;
- a conflict exposes only Keep local and Take remote, with copy that says where the displaced
  bytes remain;
- comments render as a separate stream, never merged into the body;
- archived or unavailable connections stay readable but cannot sync.
- each row exposes Edit and Delete, and the collection panel is labelled Configured collections,
  never Browse Notion;

The existing route and settings location do not move. The feature remains hidden when the health
capability is false.

Product analytics are designed with the workflow, not appended later. Emit
`source.connection_created`, `source.sync_requested`, `source.document_adopted`, and
`source.conflict_resolved` from successful user actions. Properties are limited to `project`,
`providerKind`, `connectionId`, and for conflict resolution `action`. Never send document titles,
bodies, comments, remote URLs, collection ids, or credentials. Operational sweep outcomes remain
in `source-log.ndjson`; they are not duplicated into browser analytics.

## Architecture

```text
startServer, only when CEZ_SOURCES === "1"
  |
  +-- SourceRuntime
  |     +-- SourceCoordinator
  |     |     +-- one SourceStore per project
  |     +-- WorkspaceSourceScheduler
  |     |     +-- due tick ------+
  |     +-- project queues       |
  |     +-- connection join map |
  |           +-- manual kick ---+
  |                              |
  |                       resolveSourceProvider
  |                              |
  |                         runSourceSync
  |                              |
  |                FileSourceSink, optionally wrapped by
  |                KnowledgeStore.createSourceSink
  |                              |
  |        .ai/cezar/sources/<connection>/<doc>.md
  |                              |
  |                    F1 notifyChanged + watcher
  |                              |
  |                       one knowledge index
  |
  +-- createSourcesRoutes({ runtime })
          +-- connection CRUD -> same SourceStore -> reschedule
          +-- sync -> runtime.kick -> 202 {syncId}
          +-- comments -> source-comments.ndjson
          +-- resolve -> provider + sink -> existing response

cockpit Sources section
  -> typed api-client
  -> existing /api/v1/p/:projectId/sources routes
  -> source-sync SSE invalidation plus bounded polling reconciliation
```

### Ownership and file shape

This remains an ordinary cezar vertical slice, not a module or plugin system. Expected ownership:

- `packages/cezar/src/sources/`: runtime, comment persistence/sweep, scheduler entry points,
  conflict operations;
- `packages/cezar/src/server/`: route dependencies, single-store and lifecycle wiring;
- `packages/contract/`: no response-shape change expected; only touch if parity exposes an actual
  mismatch, and fix the source rather than widen the schema;
- `packages/web/src/api/client.ts`: endpoint wrappers, including the new source mutations;
- `packages/web/src/api/queries.ts` and the existing Sources settings surface: query hooks,
  event-driven invalidation, editor, preview, and actions;
- `packages/api-client/`: no edit expected. It already supplies the typed Hono client and contract
  exports; touch it only if implementation exposes a genuinely reusable helper or type;
- `.env.example`: no change unless implementation introduces or changes an environment variable.

No new runtime dependency is permitted. No source provider is selected by a git remote. No source
file is watched by F2. No project context is constructed by a scheduled sync. No source route is
registered as a loose Hono statement.

## Phases

Each phase is independently shippable and leaves every enabled path honest.

### Phase 1: runtime and manual sync

1. Introduce `SourceRuntime`, one-store ownership, a project-level execution queue matching the
   project-wide lease, same-connection id joining, and one execution seam shared by due and manual
   runs.
2. Inject runtime-owned source stores into both boot and lazy project-context construction sites.
3. Wire source lifecycle in `startServer`: exact flag gate, boot-project-preserving registry
   refresh, project event refresh, timer start, and close cleanup.
4. Replace the sync route's pending 409 with the existing 202 contract. Reschedule after connection
   mutations.

This phase is useful without cockpit changes: CLI and API consumers can create a connection and a
real mirror is produced and indexed.

### Phase 2: typed cockpit mutations

1. Add api-client functions and query mutations for connection create/update/delete and manual
   sync.
2. Replace `unwiredSourceMutation` with create and edit forms that capture provider kind, enabled
   state, schedule, comment mode, and explicit collection id plus kind. Add confirmed delete.
3. Narrow collection route and UI copy to configured collections, with optional provider
   enrichment but no unbounded remote browse claim.
4. Invalidate named-project source queries from `source-sync` workspace events, with bounded
   polling after a kick only as missed-event and restart reconciliation.
5. Add the successful-action analytics events and their privacy assertions.

After this phase, a user can configure and run a source from the cockpit. No document-management
control is shown yet.

### Phase 3: comments and conflicts

1. Add open, defaulted comment cursor/watermark state and the append-only comment store.
2. Extend the existing sweep with bounded, fair, resumable comment enumeration.
3. Implement keep-local and take-remote against the existing sink and provider.
4. Make the comments and resolve routes return their already-published response shapes.
5. Add document preview, comment stream, adoption, and the two conflict actions to the Sources
   section.

After this phase, every route listed for F2 in `BACKWARD_COMPATIBILITY.md` has real behavior.

### Phase 4: record and runtime QA

1. Run all focused and full gates in Verification.
2. Run the flag-off injected-clock parity control and the two required mutation controls.
3. Run a real local Notion fixture E2E, then an authenticated cockpit E2E with screenshots and
   video retained.
4. Correct the stale central-hub corpus task in place through `CEZ_KB_WRITE_FILE`, leaving its
   historical text below a `CORRECTED 2026-08-30` lead-in. Add the changelog and durable decision
   note in the same corpus proposal, then prove discoverability with `cez kb search`.

Until Phase 4's runtime E2E passes, status is QA Needed, not Done.

## Data Models

### Existing models retained

`SourceConnection`, `SourceState`, `MirroredDocument`, the nested F1 `source` provenance object,
and all public wire schemas remain authoritative as defined in
`packages/cezar/src/sources/types.ts` and `packages/contract/src/sources.ts`. Storage schemas remain
`.passthrough()` and defaulted so older state loads.

### Additive source state

Add optional, default-empty maps to each connection's `SourceState`:

```ts
commentWatermarks: Record<docId, string>        // newest createdAt after a complete sweep
commentPageCursors: Record<docId, string>       // only while a comment walk is partial
commentSweepAt: Record<docId, string>           // fairness order, stored not derived on GET
```

Unknown keys already survive. Missing maps parse as `{}`. No migration command or user-authored
configuration is required.

### Comment append log

`<repoRoot>/.ai/cezar/source-comments.ndjson` stores:

```ts
{
  seq: number,
  connectionId: string,
  id: string,                 // provider comment external id
  docId: string,
  externalId: string,         // document external id
  author?: string,
  body: string,
  createdAt: string,
  attachments: Array<{ type: string, downloadable: boolean }>
}
```

The public route omits `seq` and `connectionId`, because the path already scopes the connection.
The uniqueness key is `(connectionId, id)`. The file is cezar-managed state, already named in the
original F2 on-disk layout, and remains gitignored.

### Manual kick state

The project queues and same-connection join map are memory-only:

```ts
Map<projectId, ProjectSourceQueue>
Map<`${projectId}:${connectionId}`, { syncId: string, promise: Promise<void> }>
```

It is coordination, not durable truth. One `ProjectSourceQueue` serializes every connection and
every due/manual origin before the project-wide lease. Durable progress remains in `SourceState`,
and restart recovery resumes from `pageCursor`. Losing a `syncId` on process restart is acceptable
because no status-by-id route exists and the connection record is the status surface.

No database, queue file, or second document-provenance index is introduced.

## API Contracts

All paths remain project-scoped under both canonical `/api/v1/p/:projectId/*` and the existing
boot-project alias. Existing Zod schemas remain the source of truth.

| Method | Path | Completed behavior |
| --- | --- | --- |
| `POST` | `/sources` | Create in the runtime-owned store, reschedule, return existing connection response |
| `PUT` | `/sources/:connectionId` | Revision-check, update, reschedule, return existing connection response |
| `DELETE` | `/sources/:connectionId` | Preserve current tombstone semantics, reschedule, return `{removed:true}` |
| `GET` | `/sources/:connectionId/collections` | Return configured collection ids and kinds, enriched when available; no remote browse claim |
| `POST` | `/sources/:connectionId/sync` | Queue or join one in-flight sync, return `202 {syncId}` |
| `GET` | `/sources/:connectionId/comments` | Return persisted rows for that connection in stable order |
| `POST` | `/sources/:connectionId/documents/:docId/resolve` | Apply `keep-local` or `take-remote`, return the existing document response |
| `POST` | `/sources/:connectionId/documents/:docId/adopt` | Existing move, plus runtime reschedule and live F1 notification |

The remaining source GET routes retain their current behavior. Flag off stays: every GET returns
its schema-valid empty 200 response, every mutator returns the existing 409, no provider resolves,
and no route answers 404 merely because the feature is disabled. Unknown connection or document
continues to answer 404.

`SourceProvider.listComments(ref, since?, options?)`, where options contains optional `cursor` and
`callBudget`, is the only provider-interface extension. The third argument is optional, so
existing implementations remain source-compatible. No literal provider union is introduced.

## Risks

- **Two stores over one file drift.** Prevented by runtime ownership plus injection into both
  context construction sites. Verification asserts object identity, not merely equal contents.
- **A manual kick returns 202 but loses the project-wide lease.** Prevented by one project queue
  across all connections and due/manual origins. Same-connection callers receive the same id;
  cross-process contention retains and retries the queued item instead of settling a no-op.
- **Refresh evicts an unregistered boot project.** Prevented by explicitly adding the boot id and
  root to every coordinator discovery input before absence removal.
- **The scheduler constructs a project context and resumes agents.** Prevented by coordinator root
  handles and standalone stores/sinks. A negative test fails if `contexts.context()` is called.
- **A partial Notion walk tombstones live content.** Existing `complete` gate and cursor semantics
  remain. The page-2 mutation control is mandatory.
- **Comment pagination skips, duplicates, or overruns requests.** Cursor and watermark are
  separate, watermark advances only on complete enumeration, one budget is decremented across all
  documents and pages, and compaction permanently retains one row per provider comment id.
- **Comments manufacture document conflicts.** They never enter document bodies or local-version
  hashing.
- **Take remote destroys the local edit.** The local body is written to `conflicts/` before live
  replacement. A failure after that copy is recoverable and must not delete either copy.
- **Keep local re-conflicts forever.** It advances `remoteVersionSeen` to the fetched current
  remote version while retaining the quarantine artifact.
- **Provider failure empties the mirror.** `detect unavailable` and failed fetch freeze existing
  bytes and counts. No absence diff runs on an incomplete pass.
- **Flag off performs hidden network or disk work.** Runtime construction itself is gated. Tests
  spy on provider resolution, coordinator refresh, timers, and source-path I/O.
- **Browser analytics leaks knowledge content.** Event properties use ids and provider kind only.
  Tests reject titles, bodies, comments, URLs, collection ids, and credential keys.
- **A released API is broken while being completed.** No route is removed, renamed, or widened.
  Contract parity, route parity, typed-body, package-install, and backward-compatibility inventory
  gates all run.
- **The original full-corpus rate and cost measurements are stale.** F2 measured a steady state of
  about 520 calls/day and a cold backfill of 15 to 25 minutes on the 2026-08-06 corpus
  (`2026-08-06-external-source-connectors-notion.md:64-76`). Runtime QA records current document
  count, request count, wall time, truncation, and next cursor. It does not silently reuse those
  figures as current capacity evidence.

## Verification

Do not run any command in this section without the session's required permission. Record each
exit code and keep the E2E artifacts.

### 1. Focused automated tests

Run with the repository form `npm test -- <path>`:

1. `sources/runtime.test.ts`: exact flag off constructs nothing; one store instance is shared by
   boot context, lazy context, routes, and scheduler; an unregistered boot project remains in the
   coordinator after refresh; same-connection kicks return one `syncId`; two connections in one
   project serialize; cross-process lease contention retries; two independently opened stores
   preserve concurrent connection changes, and the lease winner reloads a sibling process's newer
   definition, state, and sequences before sweeping; close stops the timer.
2. `sources/scheduler.test.ts`: due and manual work use one execution path; project add/remove
   reschedules; a manual kick racing a due tick serializes before the shared lease; scheduler sync
   never calls `contexts.context()`; a resident knowledge store gets its wrapped sink and a cold
   project uses `FileSourceSink`; two collections consume one exact document request ceiling and
   the exhausted collection cursor persists without starting the next collection; `Retry-After`
   always bounds `backoffUntil` from below.
3. `server/sources-api.test.ts`: manual sync returns 202 and changes stored state; create/update/
   delete reschedule; disable and archive persist `paused` plus `syncStateAt`; re-enable becomes
   immediately due; manual sync for disabled, archived, and unavailable connections returns 409;
   comments return persisted rows; both conflict actions preserve the displaced bytes and return
   contract-valid documents; disabled-feature mutators remain 409.
4. `sources/comments-store.test.ts` and `sources/sync.test.ts`: duplicate comment ids append once;
   partial pagination preserves cursor and does not advance watermark; complete pagination clears
   cursor; the exact shared request ceiling holds across multiple documents and multiple pages;
   compaction preserves every unique comment and a post-compaction duplicate still appends zero
   rows; oldest-swept-first ordering prevents starvation; comment bytes do not change a document's
   `localVersion`.
5. `web/src/routes/settings/sources-section.test.tsx`: Add source and Sync now issue real scoped
   requests and invalidate queries; create requires collection id plus kind and sends enabled true;
   edit and confirmed delete work; configured-collection copy makes no browse claim; conflict
   actions show only two choices; errors are verbatim; analytics contain no content fields;
   capability off issues zero source requests; disabled, archived, and unavailable rows disable
   Sync now; a `source-sync` event invalidates only the named project's source query keys.
6. Existing `contract-parity.sources.test.ts`, `route-parity.test.ts`, `typed-bodies.test.ts`,
   `bc-route-inventory.test.ts`, and api-client typecheck remain green.
7. `server/workspace-events.test.ts`: one scheduled completion and one manual completion each emit
   exactly one `source-sync` event after durable state, with project id, connection id, revision,
   and stored sync state.

### 2. Required mutation and negative controls

1. **Identifier pinning:** temporarily disable exact identifier pinning in
   `knowledge/search.ts`. The existing `SPEC-282` case must fail. Restore the source before any
   commit.
2. **Page 2:** temporarily stop Notion pagination after the first
   `block-children-page1.json` response. The fixture whose only matching content is in
   `block-children-page2.json` must fail, then pass after restoration. Assert both pages are
   returned, not merely that a request for page 2 happened.
3. **Flag-off parity:** with every central-hub flag unset, compare `/api/v1/health` and the composed
   agent system prompt against the pre-change fixture using an injected fixed clock. Provider
   resolution count, source I/O count, and armed source timer count must all be zero. A wall-clock
   comparison is invalid because two reads can accidentally share a millisecond.
4. **Single-store mutation:** restore independent `SourceStore.open` calls in project context and
   coordinator. The identity test and an API-create-then-scheduler-read test must fail.
5. **Conflict preservation:** remove the local backup before take-remote. The test must fail by
   proving the prior local body is no longer recoverable.
6. **Comment completion:** advance a comment watermark on an incomplete page. The page-2 comment
   fixture must fail because the later reply becomes unreachable.
7. **Shared comment budget:** reset the budget for every document. The multi-document fixture must
   exceed the asserted request ceiling and fail.
8. **Current conflict ref:** call `fetchDocument` with the stale quarantined ref instead of bounded
   re-enumeration. A fixture where the remote advances again before resolution must fail, and the
   unchanged keep-local body must retain the same `localVersion`.

Use `git stash push -- <source files>` and `git stash pop` for mutation proof exactly as the repo
doctrine requires. Do not stash or overwrite the spec or the user's unrelated changes.

### 3. Full gates

Run the central-hub task's five commands, because this repository has no lint or format script:

```sh
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

All five must exit 0 before commit or push. A pre-existing failure is still a red gate and must be
reported with its exact output, not rounded up.

### 4. Runtime E2E

Run against a temporary project and a local recorded Notion HTTP fixture first, with
`CEZ_SOURCES=1 CEZ_KB=1` and all writes confined to the temporary project:

1. Start cezar and create an enabled Notion connection through the cockpit, entering the fixture's
   collection id and kind. Reopen Edit and prove the configured values round-trip.
2. Click Sync now. Assert one 202 request, one sweep, visible stored progress, and a document whose
   only matching block came from fixture page 2.
3. Search that content through F1 without restarting. This proves the required in-process
   `notifyChanged` wire, not only eventual indexing on boot.
4. Add a second comment page and assert the comment appears once after resume.
5. Locally edit a mirrored body, advance the remote fixture, sync, and assert conflict state plus
   both bodies. Exercise keep-local, repeat with take-remote, and prove displaced bytes remain.
6. Adopt one document, sync again, and prove no second mirrored copy appears.
7. Restart during a partial sweep and prove it resumes from the stored cursor.

Then run the authenticated browser smoke against the intended deployment with screenshots and
video enabled. Verify create, sync, document preview, comments, both conflict actions, mobile
layout, keyboard focus, and the capability-off view. Do not point a destructive fixture at a real
Notion workspace. F2 remains read-only remotely, but local conflict/adoption state is material.

Record current document count, provider calls, elapsed time, completed versus partial result,
next cursor, and source-log outcome. User-facing status remains QA Needed until this runtime pass
and artifact review are complete.
