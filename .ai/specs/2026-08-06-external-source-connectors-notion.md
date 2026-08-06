# External source connectors: a `SourceProvider` seam and a Notion mirror

> Feature **F2** of `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`. Work packages **W1.4, W1.5, W1.6, W2.2, W4.4, W4.6, W4.8**.
> Depends on `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` (F1) for the mount that makes the mirror searchable, and on the plan's W1.1 scaffold for every shared file.
> The plan's "Resolved decisions" table (D1..D14) outranks this document wherever they disagree.

## TLDR

The content this workspace most needs to search is not in the repo. Transcribed meeting notes, task bodies and a 783 KB Knowledge page live in Notion, and cezar has no way to see any of it: there is zero Notion, knowledge-base, vector or retrieval code in the tree, and the one external-service seam it does have (`forge`) is keyed on a git remote host, which a Notion workspace does not have.

F2 adds a second seam, `SourceProvider`, plus one implementation (Notion), that mirrors remote pages to Markdown files under `<repoRoot>/.ai/cezar/sources/`. Per plan decision **D3** that root is registered by F1 as a knowledge mount, so the mirror produces files and F1 produces the one index and the one watcher over them. The mirror is read-only, incremental, resumable, and opt-in behind the exact flag `CEZ_SOURCES=1`. The credential is an environment variable and never reaches disk. The cutover primitive is **adoption**: a mirrored document is immutable until adopted, adoption moves it out of the mirror's write path forever, and therefore no remote write and no remote delete is ever needed (which matters, because the Notion surface in use here has no delete tool at all).

The one correctness requirement everything else is arranged around is **pagination**. A reader that stops at page 1 does not report an error, it reports "nothing to do", and that exact failure ran for roughly 45 consecutive loop ticks in this workspace on 2026-08-05 while a matching row sat on page 2 the entire time (`/Users/mw/loki-labs/.claude/skills/notion-sync/SKILL.md:152-163`). In this design a partial enumeration can never delete anything, and the test that proves it has a stated mutation under which it must fail.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why |
|---|----------|-----------------|-----|
| Q1 | Widen `ForgeDriver` or add a new seam? | **A new `SourceProvider` seam.** `ForgeDriver` is not touched. | Three verified facts make widening a contract break rather than an extension. (a) Resolution is keyed on the git remote host: `FORGE_HOSTS: Record<string, ForgeKind> = { 'github.com': 'github' }` and `resolveForge` returns null unless the remote parses to that host (`packages/cezar/src/server/forge/index.ts:49,63-67`). A Notion workspace has no git remote, so it is unreachable through that function by construction. (b) `export type ForgeKind = 'github';` is a single-member literal union (`packages/cezar/src/server/forge/types.ts:12`), so a second kind is a type change at every use site. (c) `forgeInfoSchema` pins `kind: z.literal('github')` (`packages/contract/src/health.ts:24-25`) on the health payload, the most externally depended-on JSON in the app. Reaching a document source through `forge` therefore means breaking a protected surface (BACKWARD_COMPATIBILITY.md section 2) to arrive at an interface whose 14 methods (`listIssues`, `listPRs`, `createPR`, `prMergeState`, `prDiff`, and friends, `forge/types.ts:237-256`) a document source implements almost none of. What is copied verbatim is the forge seam's *behaviour*: `detect()` / `detectCached()` returning `{available, reason}`, never throwing for an expected absence, bounded in-process caches, and auth cezar delegates rather than holds. |
| Q2 | Is `SourceKind` a literal union? | **No. `type SourceKind = string`, keyed into a registry.** | A literal union is exactly the `ForgeKind` mistake (Q1b), and it is being avoided on purpose, in writing, so nobody "tightens" it later. Adding Linear, Jira, Drive or Slack must be one new file plus one row in `SOURCE_PROVIDERS`, with no contract change, no route change and no UI change. A literal union makes each of those a change to `packages/contract`, which is the package whose typecheck serializes every other branch. |
| Q3 | Capabilities: optional methods, or data? | **Data.** `capabilities: SourceCapabilities` with five required booleans (`list`, `fetch`, `poll`, `push`, `comments`). | The cockpit has to say "read only" *before* it calls anything. `typeof provider.pushDocument === 'function'` is not answerable over HTTP, so an optional-method design forces the server to re-describe the provider by hand in the response, which is exactly the drift `contract-parity*.test.ts` exists to catch. Required booleans mean a partial object fails `parse`, and a provider that forgets one fails `npm run typecheck`. |
| Q4 | Where do mirrored bytes land? | **`<repoRoot>/.ai/cezar/sources/<connectionId>/<docId>.md`, and F1 registers that root as a knowledge mount** (plan D3). | This is the wire three independent designs left unconnected: the mirror wrote into a directory the knowledge base never read. Origin decides the treatment. A file on disk is mounted. A Notion page is not a file, so it is materialised first and then mounted like any other file. One store reads both. |
| Q5 | Two indexes and two watchers over the same bytes? | **No. ONE content index (F1's) and ONE watcher (F1's).** F2 builds no search index and calls `fs.watch` zero times. | The adversarial review found both designs keeping their own index and their own watcher over the same files, which is two debounce timers racing one atomic rename and two answers to "what does this corpus contain". F2 is a *writer*. It is **required** to notify F1 in process at every sweep commit (plan D15), and F1 owns discovery, parsing, indexing and watching. See "The F1 seam (D3), stated as a contract". |
| Q6 | Is freshness computed at request time? | **No** (plan D8). Freshness is a **stored timestamp** (`lastCompleteSweepAt`, `mirroredAt`, `syncStateAt`) plus a **stored enum** (`syncState`). Nothing in a handler reads the clock. | The earlier design made `freshness` a required field derived from `now` on every document GET, and made that its headline guarantee. `route-parity.test.ts` issues the same GET three times and compares status, content type and body byte for byte (`packages/cezar/src/server/route-parity.test.ts:136-147`), and its timestamp normalizer is applied only to paths starting `/github` (`:132,137`). A value that crosses its own threshold between two of those three requests is a red gate that gets debugged as alias drift for a day. The stored-state form keeps the guarantee (both fields stay REQUIRED on the wire, so omitting either is a typecheck failure) and removes the flake. |
| Q7 | Auth model? | **Environment only.** `CEZ_NOTION_TOKEN`, falling back to `NOTION_TOKEN` then `NOTION_API_KEY`. No token field in the UI, no token key in any schema, nothing written to disk. | OAuth is rejected because cezar would become the first component in the codebase to persist a refresh token on disk, and `CODE_REVIEW.md:58` lists "secret written to disk" as a merge blocker. The only credential the project deliberately keeps is in the environment (`GH_ALLOW_NAMES` in `packages/cezar/src/core/agent-env.ts:226-232`). Riding the user's existing claude.ai MCP connector is rejected on two independent grounds: cezar contains no MCP client (every `mcp` path in the tree is opaque config-file editing, `packages/cezar/src/agent-config/catalog.ts:137-148`, or a read-only listing of server names), and that OAuth session is bound to the claude.ai client on the user's machine, not to a headless VPS process. All three chosen names match `SECRET_NAME_RE` (`packages/cezar/src/core/secret-redaction.ts:28-29`), so they are stripped from every spawned agent's environment and redacted from NDJSON transcripts for free, and they are deliberately absent from `BACKEND_ALLOW_PREFIXES` and `GH_ALLOW_NAMES` (`agent-env.ts:202,226`). |
| Q8 | Flag and default? | **`CEZ_SOURCES=1`, exact string, off otherwise** (plan D4). Unset means no timer, no route work, no nav change, no prompt bytes. | `AGENTS.md:14`: features that widen exposure or cost are opt-in behind a `CEZ_*` flag, off by default. The precedent is the follow-up inbox, which reads `env.CEZ_FOLLOWUPS === '1'` (`packages/cezar/src/handoff.ts:127-129`) and answers 409 from a named constant when off (`packages/cezar/src/server/server.ts:393,4344`). `!== '0'` (unset means on) is specifically not used: an integration that reaches the network by default is the safe-default rule inverted. |
| Q9 | Write-back / push in phase 1? | **No.** The mirror is read-only. `pushDocument?` stays optional on the interface, the Notion provider declares `capabilities.push: false`, and there is **no push route**. | Adding a route later is additive and allowed; removing one is breaking (BACKWARD_COMPATIBILITY.md section 2, general rule). Shipping a push route that 409s forever is a contract nobody agreed to keep. It also deletes two env vars from the phase-1 surface. |
| Q10 | Does anything get deleted on the remote? | **Never.** No route, no code path, no provider method issues a remote delete. | Adoption (Q11) removes the need entirely, and the Notion MCP surface the rest of this workspace uses has no delete or archive tool at all, so a design that depends on one is undeliverable on the surface it targets. |
| Q11 | How does content stop being a mirror and become ours? | **Adoption**, and it is a one-way move. A mirrored doc is immutable until adopted; adoption flips `origin` to `local`, records `adoptedAt`, records the `externalId` in a durable adopted set, and **moves the file out of `sources/`** into **F1's writable knowledge root** (`<repoRoot>/.ai/cezar/knowledge/`, plan **D16**; there is no `adopted/` directory in any configuration). | Two properties fall out. The sweep can never touch an adopted document again (it is not in the directory it writes). And the adopted set is what stops the *next* sweep re-mirroring the same page as a brand new document, which is the hole a naive "flip a flag" adoption leaves. Adoption is also the reason a connection can be retired by setting `mode: 'archived'` instead of deleting anything remotely. |
| Q12 | Document identity and filename? | **The provider's opaque id, hashed.** `docId = sha256(kind + ':' + workspaceId + ':' + externalId)` truncated to 16 hex characters, and `<docId>.md` is the filename. Title lives in frontmatter. | A Notion page id survives a rename and a move; a title survives neither. Naming the file after the title makes every rename a delete plus a create in git and in F1's watcher. Named after the hash, a rename is one frontmatter field. sha256 matches the existing content-hash idiom (`packages/cezar/src/agent-config/files.ts:17-19`) and needs no dependency. 64 bits at the 5,000-document cap gives a birthday collision probability near 7e-13, and a collision is detected (two different `externalId`s hashing equal is a hard error, never a silent overwrite). |
| Q13 | When may absence imply deletion? | **Only when the enumeration reached exhaustion.** `SourceChangePage.complete` is `true` only after `has_more` went false, and tombstoning is gated on it. | This is the recorded ~45-tick false-empty made unreachable by construction rather than by discipline. See "Pagination is a correctness requirement". |
| Q14 | Both sides changed. Merge, or clobber? | **Neither. Quarantine.** The incoming body is written to `conflicts/<docId>.remote-<shortVersion>.md`, the document goes to `state: 'conflict'`, the local bytes are not touched, **and the watermark still advances**. | Silent overwrite of a locally edited file is the data-loss class `CODE_REVIEW.md:58` calls a blocker. Not advancing the watermark is the other failure: one unresolvable document would stall the whole connection forever, and every subsequent tick would re-fetch and re-conflict it. |
| Q15 | Where does the sync timer live? | **Beside the automations engine, never inside it.** The source-agnostic earliest-due timer is extracted to `src/scheduling/due-scheduler.ts` (W1.6, a pure refactor) and a second coordinator/scheduler/lease is stood up over `sources.json`. | `automationEventSchema` is four GitHub event literals (`packages/cezar/src/automations/types.ts:4-9`), `ProjectAutomationHandle` hard-types `owner`, `repo` and a `GithubPoller` (`packages/cezar/src/automations/scheduler.ts:13-21`), and registration is gated on a `github.com` remote in two places in `server.ts` (`:5219,:5240`). A Notion job cannot live there without breaking three protected shapes. Sources also never enter `GithubRequestArbiter`, which is one request chain process-wide (`automations/scheduler.ts:23-25`), or one large page would stall the PR list. |
| Q16 | Images, files and other binary attachments? | **Not fetched in phase 1.** Recorded in the document's `lossy[]` set and rendered as a named count, never dropped silently. | Notion's file URLs are signed and expire in about an hour, so storing the URL as if it were permanent produces a document full of dead links, which is worse than an honest "3 images not mirrored". Fetching them is additive later and needs its own flag and its own retention answer. |
| Q17 | Comments? | **Mirrored to a separate append-only stream** (`source-comments.ndjson`), swept per document, never written into document bodies. | Comments are the one surface nothing else in this workspace can see, and they carry the second human's contributions. They cannot go in the body: an out-of-band reply would change the local bytes, change `localVersion`, and manufacture a conflict (Q14) on a document nobody edited. |

## Problem Statement

Three things are true at once and together they are the feature.

**1. The content is not in the repo.** The five Notion databases plus the Knowledge page hold task bodies (measured at 2.4 KB to 9.9 KB each), a 783,077-character Knowledge page, and the meeting notes that motivate this work: five real transcribed notes with AI-generated cited summaries plus full verbatim transcripts, living under private wrapper pages structurally disconnected from every workflow database. None of it is a file, so none of it can be mounted, indexed, grepped, or handed to an agent.

**2. cezar cannot read any of it, and has no seam that could be bent to.** There is no Notion code, no knowledge-base code, no retrieval and no MCP client anywhere in the tree. The single external-service seam is `forge`, and it is GitHub-shaped in the three specific places Q1 lists: `forge/index.ts:49` keys resolution on a remote host, `forge/types.ts:12` makes the kind a one-member literal, `contract/src/health.ts:25` pins that literal into the health contract. The automations engine is likewise GitHub-shaped at `automations/types.ts:4-9`, `automations/scheduler.ts:13-21` and `server.ts:5219,5240`. There is nothing to extend; there is something to sit beside.

**3. The naive version of this feature has a known, recorded way of failing silently.** Not by erroring. By reporting emptiness. On 2026-08-05 a first-page-only read reported "no Todo rows" for roughly 45 consecutive loop ticks while a Todo row sat on page 2 the whole time, and the first diagnosis of it was itself wrong (`/Users/mw/loki-labs/.claude/skills/notion-sync/SKILL.md:152-163`, corrected the same day: the cause was a board past 300 rows, not a small page size). Any mirror that treats "I did not see it" as "it is gone" inherits that failure and upgrades it from a stalled loop into deleted documents.

A fourth constraint bounds the solution rather than motivating it: cezar is a published npm package with nine mechanically guarded protected surfaces, an exhaustive six-package runtime dependency budget (`CODE_REVIEW.md:52`), a route inventory that fails the suite when a route is undocumented, three-way byte parity on every project-scoped GET, and no linter. Every design choice below that looks conservative is paying that bill.

## Research

### The forge seam, and exactly what is reusable from it

Reusable, and copied: the availability contract. `detectGithub` caches for 60 s and `detectGithubCached` returns the last known value while firing a refresh off the request path, so `/api/health` never shells out. `AGENTS.md:77` states the rule the new provider inherits verbatim in behaviour: no `gh`, no remote, offline all return `{ available: false, reason }`, never an error. Not reusable: resolution, the kind type, and the wire shape, for the reasons in Q1.

### The automations engine, and exactly what is reusable from it

Reusable in shape, and re-implemented rather than shared, because sharing means widening protected types:

- **The lease.** `acquireLease(staleAfterMs = 10 * 60_000)` opens `automation-poll.lock` with `openSync(path, 'wx', 0o600)` and reclaims a lock whose mtime is older than the stale window (`packages/cezar/src/automations/store.ts:32,208-219`). Copied exactly, as `sources-poll.lock`.
- **The store idioms.** Definitions with an optimistic-concurrency `revision` that throws on mismatch (`store.ts:94-103`), delete as a tombstone rather than a removal (`store.ts:258-259`), an append-only NDJSON log with a monotonic `seq` and size-triggered compaction (`store.ts:168-206,236`), 90-day retention (`store.ts:33`).
- **Coordinator discovery.** A project is an automation project purely because `<root>/.ai/cezar/automations.json` exists (`automations/coordinator.ts:45`). Copied: a project is a source project purely because `sources.json` exists. No git remote is consulted anywhere.
- **The earliest-due timer.** `WorkspaceAutomationScheduler` collects due entries across projects, sorts them, and arms exactly one `setTimeout` for the earliest, re-arming on completion (`automations/scheduler.ts:158,187-204`). This is the one piece genuinely worth sharing rather than copying, hence W1.6.

Not reusable at all, and untouched: `automationEventSchema` (four GitHub literals), `ProjectAutomationHandle` (`owner`, `repo`, `GithubPoller`), the `github.*` placeholder allowlist, and the `github.com` registration gate.

### The storage idioms this feature must obey

zod schemas with every new field optional or defaulted and `.passthrough()` preserved, because the loader `safeParse`s a whole array and a required new field silently drops every pre-existing row (BACKWARD_COMPATIBILITY.md section 3). Atomic `tmp` plus `rename` at 0600. Corrupt input degrades to empty plus one warning, never a throw. Per-entry salvage so one malformed row never evicts its siblings. sha256 of the exact bytes as the version, because mtime is coarse and lies across filesystems (`packages/cezar/src/agent-config/files.ts:17-19`), with a stale-write guard that refuses when the caller's version no longer matches disk (`files.ts:80,101-102`).

### Notion's API, and the arithmetic that decides the design

Pinned version `2022-06-28` against `https://api.notion.com`, which is the same pairing already in production use in this workspace from a Cloudflare Worker (`/Users/mw/loki-labs/chat/domains/chatbots/worker/src/tools/report-issue.ts:76-77,361`), so the surface is known good. The rate ceiling is roughly 3 requests per second per integration.

Steady state on the measured corpus is about 36 changed rows per day. At a 900 s interval that is 96 ticks times (about 5 collection list calls plus roughly 0.4 body fetches), near 520 calls per day, about 0.006 req/s: three orders of magnitude under the ceiling. The interval is not the problem.

The cold backfill is. About 1,319 rows plus a 783 KB page needs roughly 14 list calls and at least 1,319 `blocks/children` calls, which is about 8 minutes at the theoretical ceiling and realistically 15 to 25 minutes once block nesting is counted. That cannot be one tick. **Therefore per-collection cursor persistence, so a tick resumes mid-collection instead of restarting, is load-bearing correctness, not an optimisation.** Without it the connection never finishes its first sweep, `lastCompleteSweepAt` is never written, and nothing is ever safe to tombstone.

One structural property of the target content makes the mirror viable: the Knowledge page contains no images, files, embeds, bookmarks, toggles, columns, synced blocks or inline databases, only prose, 4,623 inline-code spans, 8 code fences, 13 tables and 328 bullets. It is losslessly representable as Markdown. Task bodies, report bodies and meeting notes are not that page, which is why the lossiness contract is declared for everything regardless.

## Proposed Solution

Five parts, in the order a request travels through them.

1. **A provider seam and a registry.** `SourceProvider` is an interface with a declared `kind`, declared capability **data**, a non-throwing availability probe, collection listing, document listing and fetching, and an incremental `pollChanges`. `resolveSourceProvider(connection, deps)` looks the connection's declared `kind` up in `SOURCE_PROVIDERS: Record<SourceKind, SourceProviderFactory>` and returns `null` for an unknown kind without throwing. No git remote is consulted anywhere in the module.

2. **A Notion provider over `fetch` plus zod.** Database queries and block trees enumerated to exhaustion, blocks converted to Markdown with a per-document recorded `lossy[]` set, oversized pages split on H2 into section documents, and a per-document comment sweep. No new dependency: the runtime budget stays hono, @hono/node-server, yaml, zod, smol-toml, ws.

3. **A resumable sweep.** Acquire the lease, resume from the persisted `pageCursor`, ask the provider for changes since the watermark, skip any document whose `remoteVersion` matches what is stored, fetch and convert the rest, write through the sink, quarantine divergence, tombstone only on a complete enumeration, advance the watermark, back off with jitter on 429 and 5xx, release the lease, write the stored `syncState`.

4. **A file sink whose output F1 mounts.** One Markdown file per document named by `docId`, YAML frontmatter carrying every provenance field F1 must pass through, under a root F1 registers as a knowledge mount (D3). F2 writes; F1 indexes and watches.

5. **Adoption as the cutover.** One route, one move, one durable record. After it, cezar owns the document and the remote is irrelevant to it forever.

The whole thing is inert with `CEZ_SOURCES` unset: routes exist and degrade (GET answers `200 []`, mutators answer 409, **never 404**, per plan D19), no timer is armed, no provider is constructed, and the health payload is byte-identical to the pre-change build.

## Architecture

### Module layout, mapped to plan work packages

```
packages/cezar/src/sources/
  types.ts          W1.5  storage zod schemas, the SourceSink port, MirroredDocument
  store.ts          W1.5  sources.json + source-state.json + source-log.ndjson + lease + adopt
  sink.ts           W1.5  FileSourceSink: one <docId>.md per doc, frontmatter, conflicts/
  provider-types.ts W2.2  SourceProvider, SourceKind, SourceCapabilities, SourceChangePage
  registry.ts       W2.2  SOURCE_PROVIDERS + resolveSourceProvider
  notion/
    client.ts       W1.4  fetch + zod against api.notion.com, paging, rate bucket, backoff
    markdown.ts     W1.4  block tree to Markdown, lossy[] accounting, H2 split
    comments.ts     W1.4  per-page comment listing and normalisation
    provider.ts     W2.2  the SourceProvider adapter over the W1.4 client
    fixtures/       W1.4  recorded API payloads, no live network in any test
  sync.ts           W4.4  the sweep
  coordinator.ts    W4.4  discover source projects by the existence of sources.json
  scheduler.ts      W4.4  one workspace timer over the extracted due-scheduler
packages/cezar/src/scheduling/
  due-scheduler.ts  W1.6  the earliest-due timer, extracted from the automations scheduler
packages/cezar/src/server/
  sources-routes.ts W4.6  handlers filling the scaffold's inert family
packages/web/src/
  routes/settings/sources-section.tsx   W4.8
  components/source-status-badge.tsx    W4.8
```

Everything else this feature needs is scaffold-owned (plan W1.1) or activation-owned (plan W3.1) and **is not touched by any package here**: `packages/contract/src/sources.ts` and `index.ts`, `server/server.ts`, the inert `sources-routes.ts` family declaration, `contract-parity.sources.test.ts`, `typed-bodies.test.ts`, `packages/cezar/src/index.ts` (the gitignore list), `paths.ts`, the web `client.ts` / `queries.ts` / `registry.tsx` / `nav-items.ts` / `routes.tsx`, `BACKWARD_COMPATIBILITY.md`, `README.md` and `.env.example`. If a package here finds it needs a route the scaffold did not create, it stops and hands back, per the plan's dispatch contract clause 5.

### The provider seam

```ts
/** Registry-keyed. NOT a literal union: that is precisely the ForgeKind
 *  mistake (forge/types.ts:12), and it is being avoided on purpose. */
export type SourceKind = string;

export interface SourceCapabilities {
  list: boolean; fetch: boolean; poll: boolean; push: boolean; comments: boolean;
}

export interface SourceProvider {
  readonly kind: SourceKind;
  /** DATA, never `typeof provider.x === 'function'`: the cockpit must be able
   *  to say "read only" before it calls anything, and the server must be able
   *  to serialise that answer. */
  readonly capabilities: SourceCapabilities;
  detect(): Promise<SourceAvailability>;          // never throws for an expected absence
  detectCached(): SourceAvailability | null;      // never touches the network on a read path
  listCollections(): Promise<SourceCollection[]>;
  listDocuments(opts: SourceListOptions): Promise<SourceDocumentPage>;
  fetchDocument(ref: SourceDocumentRef): Promise<SourceDocument | null>;
  pollChanges(since: SourceWatermark | null, opts: SourcePollOptions): Promise<SourceChangePage>;
  listComments?(ref: SourceDocumentRef, since?: string): Promise<SourceCommentPage>;
  pushDocument?(input: SourcePushInput): Promise<SourcePushResult>;  // declared, unused in phase 1
  viewUrl(ref: SourceDocumentRef): string | null;
}

export interface SourceChangePage {
  changes: SourceChange[];        // {type:'upsert', doc} | {type:'tombstone', externalId}
  watermark: SourceWatermark | null;
  nextPageCursor: string | null;
  complete: boolean;              // true ONLY after enumeration reached exhaustion
  truncated: boolean;             // the call budget stopped us, not the data
}
```

### Pagination is a correctness requirement

`complete` is the only thing standing between a partial read and deleted documents, so it is threaded end to end: the client sets it from Notion's `has_more`, the provider propagates it, the sweep gates on it, the store records it as `lastCompleteSweepAt`, and the wire exposes it as `complete` on the connection.

The rule, stated once: **absence-inferred deletion is legal only when `complete === true`.** A sweep that stopped early for any reason (call budget, HTTP error, 429, a thrown parse) records `lastError`, keeps `pageCursor`, does not advance the watermark, does not write `lastCompleteSweepAt`, and tombstones nothing.

The negative control that proves the gate is load-bearing is in Verification, together with the exact one-line mutation under which it must fail. A test that passes with and without the gate is decorative and would be removed.

### The sweep, step by step

1. **Lease.** `acquireLease()` on `sources-poll.lock`. Held means this tick returns immediately. Reclaimed only on a 10-minute stale mtime, copying `automations/store.ts:208-219`.
2. **Skip.** `enabled === false`, `mode === 'archived'`, or `backoffUntil` in the future ends the tick with `syncState` unchanged.
3. **Probe.** `provider.detect()`. Unavailable ends the tick with `syncState: 'unavailable'` and the provider's verbatim reason, and **freezes the mirror in place**: no document is touched, no count changes. A revoked token must never look like an empty workspace.
4. **Enumerate.** For each collection, `pollChanges(watermark, { cursor, callBudget })`. Resume from the persisted `pageCursor` when one exists. Every call is charged against a per-connection token bucket and a per-tick call budget.
5. **Diff before fetch.** For each upsert candidate, read the stored `remoteVersionSeen` (from the sink) and skip the body fetch when it matches. This is what keeps the steady state near 0.006 req/s.
6. **Convert.** `fetchDocument` then blocks to Markdown, accumulating `lossy[]`. A body over `maxBodyBytes` splits on H2 into section documents whose `externalId` is `<pageId>#<headingBlockId>` (stable across a re-parse, which is what stops a split page churning every sweep).
7. **Write.** Through the sink, which computes `localVersion` as sha256 of the exact bytes and returns `{localVersion, changed}`.
8. **Quarantine.** If the stored `localVersion` no longer matches the bytes on disk (someone edited the mirror) and the incoming `remoteVersion` differs from `remoteVersionSeen`, write the incoming body to `conflicts/<docId>.remote-<shortVersion>.md`, set `state: 'conflict'`, leave the local body untouched, log it, **and continue**. The watermark advances past it.
9. **Tombstone.** Only when every collection returned `complete: true`: documents present in the mirror, absent from the exhaustive enumeration, not adopted and not already tombstoned move to `deleted/<docId>.md` with a 90-day retention.
10. **Commit.** Persist watermarks, clear `pageCursor`, write `lastSuccessAt`, write `lastCompleteSweepAt` when and only when every collection was complete, recompute the stored counters, write `syncState` plus `syncStateAt`, append one log row, release the lease, **notify F1 through the required `notifyChanged` call** (see the seam section), emit the `source-sync` workspace SSE event.

### Rate limiting, backoff and concurrency

Each connection owns a serialized request chain plus a token bucket at 2.5 req/s (below Notion's ~3 to leave headroom for the rest of the workspace's own traffic against the same integration). Connections are independent of one another, so two connections issue requests concurrently while one connection's requests are strictly serial. **Sources never enter `GithubRequestArbiter`** (`automations/scheduler.ts:23-25`), because that is one chain process-wide and a 783 KB page behind it would stall the PR list; and they do not run unbounded either, because concurrency is bounded by the number of *enabled* connections, which defaults to zero and is visible in the cockpit.

Backoff on 429 honours `Retry-After` when present. Otherwise exponential from 60 s doubling to a 6 h ceiling with full jitter, persisted as `backoffUntil` so a restart does not reset it.

### Block to Markdown, and the honest lossiness contract

**Lossless:** paragraphs, H1 to H3, bulleted and numbered lists, to-dos, quotes, dividers, fenced code with its language, inline code, bold, italic, strikethrough, links, simple tables.

**Lossy, named per document in `lossy[]`, and never dropped in silence:**

- `image`, `file`, `video`, `pdf`, `audio`: the signed URL expires in about an hour, so it is never stored as if permanent. The block id and the caption are kept, and the rendered document says "N attachments not mirrored".
- `embed`, `bookmark`: reduced to the link plus its title.
- `synced_block`: deduplicated by the original block id, or the same text mirrors N times across N pages and poisons every search result.
- `column_list`: flattened into document order; the grouping is lost.
- `toggle`: heading plus nested content; the collapse state is lost.
- `child_database`: a link, not the rows. Mirroring a nested database from inside a page body would silently double-count it against `maxDocuments`.
- `equation`, `mention`: preserved as text, not as their rendered form.
- `comment`: a separate stream by design (Q17).
- `unsupported`: the catch-all, so a block type Notion adds later is recorded rather than dropped.

### Meeting notes, the motivating case

Meeting notes are a `page-tree` collection rooted at whatever the user shares with the integration. An internal Notion integration sees only explicitly shared pages, and these live under private wrapper pages outside every workflow database, so the default experience without a deliberate share is an empty list. That must not read as "the feature is broken", so **a collection that enumerates zero documents while the connection is available reports its own distinct reason** ("no pages shared with this integration: open the page in Notion, then the ... menu, then Connections, then add the integration") rather than the generic empty state. "Shared with nobody" and "genuinely empty" are otherwise the same JSON.

A note is split into a `summary` document and a `transcript` document linked by `parentExternalId`, so 28 KB of verbatim speech does not dominate every search result the summary should have won. Citation footnotes are rewritten to point at the mirrored transcript when it exists, and left as the original Notion URL when it does not. They are never rewritten into a relative link that resolves to nothing.

### Comments

Notion has no workspace-wide comment query, so comments are swept per document: only for connections with `watchComments`, capped per tick, ordered oldest-swept-first so no document starves. They land in `source-comments.ndjson` (append-only, `seq`, compaction) and never inside a document body, for the reason in Q17. An image attachment the integration cannot read is recorded as `{type: 'image', downloadable: false}` and surfaced as a count, because a screenshot that is silently absent is worse than one that is declared unreadable.

## The F1 seam (D3), stated as a contract

This is the wire the review found unconnected, so it is written as an interface, not as an intention.

### Who owns what

| Concern | Owner | Not the owner |
|---|---|---|
| Document bytes under `sources/<connectionId>/` | **F2** (this spec) | F1 never writes there |
| The mount registration for that root | **F1** | F2 never registers a mount |
| Discovery, parsing, the search index | **F1** (one index) | F2 builds none |
| Filesystem watching | **F1** (one watcher) | **F2 calls `fs.watch` zero times** |
| Change detection over mirrored bytes | **F1**, through two triggers it owns: its watcher and its `notifyChanged(root)` (D15) | F2 owns neither trigger, and **must call `notifyChanged` after every sync batch** |
| Per-connection cursors, watermarks, backoff | **F2** (`source-state.json`) | F1 never reads it |
| Per-document provenance | **frontmatter on the document itself** | neither side keeps a second copy |

**One index, one watcher, and which:** F1's. F2 is a writer, and a writer that also watches its own output is two debounce timers racing one atomic rename. Per plan **D15** there are **two triggers over those bytes and F1 owns both**: F1's single debounced `fs.watch` across every root including the mirror root, **and** F1's `notifyChanged(root)`, which F2 calls in process after each sync batch commits. That call is **required, not best effort**, and it is not a belt-and-braces addition to the watcher: a sync batch is a bulk write of many files under one root, which is exactly the case `fs.watch` handles worst (coalesced or dropped events, inconsistent recursion across platforms), so a batch whose notification is skipped is a batch the index may never see. The relationship runs the other way from the earlier wording: the notification is the trigger the sweep is accountable for, and the watcher is what covers what F2 cannot signal (a human editing a mirrored file, or `git checkout` moving many at once). F2 still calls `fs.watch` zero times.

**`conflicts/` and `deleted/` are never indexed.** Both sit under the mirror root, and the mirror root is mounted, so excluding them is a **correctness requirement of putting them there**, not a nicety. Per plan **D18** those two directory names are excluded under any mirror root by **F1's exclusion list**, which is the only exclusion list in play because F1 owns discovery. Without it a quarantined remote body surfaces as a second document beside the live original it disagrees with, and a tombstoned document stays searchable for its full 90-day retention, so the knowledge base answers with the copy the user deleted.

### The field carry-through, exactly

The mirror owns provenance that F1's document schema must transport unchanged, or adoption, conflict handling and staleness all break at the seam. Per plan **D17** that provenance is **one nested `source` object, defined once in F1's knowledge document schema and referenced here by name**, never a flat field list restated on both sides. Its members, as F1 defines them:

`source` = { `kind`, `connectionId`, `externalId`, `url`, `remoteVersion`, `origin` (`remote` | `local`), `state` (`ok` | `conflict` | `tombstoned` | `truncated`), `mirroredAt`, `lossy[]` }.

F1 carries that object through from frontmatter to its record and back out on its own wire, additively and without interpretation, and **nothing outside it crosses the seam.** `adoptedAt` is the tenth member of that object and lives **inside** it (plan **D24**), not at top level: it is provenance about the mirrored origin, so it belongs with the rest of the provenance, and an earlier draft of this spec put it outside while F1 put it inside, which is exactly the drift naming the object once is meant to prevent. The remaining fields the earlier flat list named and this object does not (`collectionExternalId`, `parentExternalId`, `remoteVersionSeen`, `localVersion`, `docType`, `properties`, `unresolvedComments`) are folded back into F2: they stay in the same frontmatter, the sweep reads them for itself through `readMeta`, and F1 neither parses nor republishes them. That is the point of naming the object once rather than enumerating it twice: there is a single definition, so the two specs have nothing to drift from.

Two members are load-bearing beyond storage. `origin` is what makes a document immutable: F1 must refuse a write to a document whose `source.origin` is `'remote'` and point the user at adoption instead, and adoption is exactly the flip of that field to `'local'`. `state: 'conflict'` is what makes a document renderable as needing attention rather than as ordinary content.

### The sink port

```ts
export interface SourceSink {
  upsert(doc: MirroredDocument, body: string): Promise<{ localVersion: string; changed: boolean }>;
  readMeta(docId: string): Promise<MirroredDocumentMeta | null>;  // frontmatter only, bounded read
  read(docId: string): Promise<{ body: string; localVersion: string } | null>;
  list(connectionId: string): Promise<MirroredDocumentMeta[]>;
  quarantine(docId: string, remoteVersion: string, body: string): Promise<void>;
  tombstone(docId: string, at: string): Promise<void>;
  /** The cutover. Moves the file OUT of the mirror root into F1's writable
   *  knowledge root (`.ai/cezar/knowledge/`, D16) and returns its new
   *  identity. One-way. There is no `adopted/` root. */
  adopt(docId: string): Promise<{ path: string; adoptedAt: string }>;
  /** REQUIRED after every sweep commit, never best effort (D15). Forwards to
   *  F1's `notifyChanged(root, docIds?)` verbatim (plan D25: root is required
   *  because F1 indexes by root, `docIds` narrows the reindex when the caller
   *  knows what changed). `FileSourceSink` implements it as a no-op
   *  only because with `CEZ_KB` unset there is no index to notify. */
  notifyChanged(root: string, docIds?: readonly string[]): void;
}
```

`FileSourceSink` (W1.5) is the default and makes the feature work standalone with `CEZ_KB` unset: it writes and reads the same files, and **adoption always moves the bytes into F1's writable knowledge root**, `<repoRoot>/.ai/cezar/knowledge/<docId>.md` (plan **D16**). There is **no `adopted/` root**, in either configuration: one writable root is what structurally prevents an adopted document landing in a directory nobody indexes. When `CEZ_KB=1`, F1 supplies its own sink implementation at `ProjectContext` build time (plan W3.1), writing to that same root and re-indexing on the move; with `CEZ_KB` unset the bytes land in the same place and are simply not indexed until the knowledge base is switched on. Neither side blocks the other, and the failure mode if F1 is absent is a mirror that is written but not searchable, which is degradation, not breakage.

**No second copy of the provenance.** `source-state.json` holds per-connection state only: revision, watermarks, `pageCursor`, backoff, timestamps, `lastError`, counters, the adopted `externalId` set, and the tombstone set. It holds **no per-document rows**, which is what structurally prevents the second index the review found. Per-document provenance is read from frontmatter through `readMeta`, once per *changed candidate*, which at roughly 36 changes a day is nothing and on a cold backfill is an `ENOENT` per new document.

## Data Models

### On-disk layout, per project

```
<repoRoot>/.ai/cezar/
  sources.json                                  # connection definitions, revision + tombstones
  sources.json.tmp
  source-state.json                             # watermarks, pageCursor, backoff, counters, adopted set
  source-state.json.tmp
  source-log.ndjson                             # append-only audit, seq, compacted past 10,500 rows
  source-comments.ndjson                        # mirrored comment threads, append-only
  sources-poll.lock                             # O_EXCL lease, 0600, 10-minute stale reclaim
  sources/<connectionId>/<docId>.md             # body; frontmatter is the document metadata
  sources/<connectionId>/conflicts/<docId>.remote-<shortVersion>.md   # NOT indexed (D18)
  sources/<connectionId>/deleted/<docId>.md     # tombstoned bodies, 90-day retention. NOT indexed (D18)
  knowledge/<docId>.md                          # adopted documents land in F1's writable
                                                #   knowledge root (D16). DELIBERATELY committable
```

Every path above except `knowledge/` goes into `ensureDataGitignore`'s `wanted` array (`packages/cezar/src/index.ts:664-683`), which the plan's W1.1 scaffold owns and edits in the same commit that documents the env vars. `knowledge/` is deliberately excluded from that list: it is content the user now owns, and the plan's dispatch contract clause 8 names content as the exception to the gitignore rule. `sources.json` is gitignored to match `automations.json`, because a connection definition carries a workspace id and collection ids and a public repo should not acquire them by accident.

### Storage schemas (`packages/cezar/src/sources/types.ts`, W1.5)

Every object is `.passthrough()`; every new field is optional or has a `.default()`. Both are BACKWARD_COMPATIBILITY.md section 3 requirements, not style.

```ts
sourceConnectionSchema = {
  id:               string().regex(PROJECT_ID_RE)     // URL-segment safe, workspace/config.ts:27
  revision:         int().positive()                  // optimistic concurrency, automations shape
  kind:             string().min(1).max(32)           // 'notion'. A STRING (Q2)
  name:             string().min(1).max(200)
  enabled:          boolean().default(false)
  mode:             enum(['mirror','archived']).default('mirror')
  intervalSeconds:  int().min(300).max(86_400).default(900)
  collections:      array(sourceCollectionRefSchema).max(50)
  watchComments:    boolean().default(false)
  maxDocuments:     int().min(1).max(20_000).default(5_000)
  maxBodyBytes:     int().min(4_096).max(4_194_304).default(524_288)
  createdAt / updatedAt: string().datetime()
  deletedAt:        string().datetime().optional()    // tombstone, never a hard delete
}

sourceCollectionRefSchema = {
  externalId:      string().min(1).max(200)           // Notion database id or root page id
  collectionKind:  enum(['database','page-tree'])
  label:           string().max(200).optional()
  maxDepth:        int().min(1).max(8).default(3)     // page-tree only
  splitOnHeading:  enum(['none','h2']).default('h2')  // the 783 KB Knowledge page case
}

sourceStateSchema = {                                 // per connectionId, source-state.json
  revision:            int()
  watermarks:          Record<externalId, { timestamp: string; tieBreaker: string }>
  pageCursor:          { collectionExternalId: string; cursor: string } | undefined
  lastAttemptAt / lastSuccessAt / lastCompleteSweepAt: string().datetime().optional()
  lastError:           { at: string; message: string; status?: int }.optional()
  backoffUntil:        string().datetime().optional()
  nextDueAt:           string().datetime().optional() // WRITTEN by the scheduler, never derived (D8)
  syncState:           enum(['never-synced','ok','stale','error','unavailable','paused'])
                         .default('never-synced')
  syncStateAt:         string().datetime().optional()
  documentCount / conflictCount / tombstoneCount / unresolvedComments: int().default(0)
  adoptedExternalIds:  array(string()).max(20_000).default([])
  tombstonedExternalIds: array(string()).max(20_000).default([])
}
```

`adoptedExternalIds` is the field a naive adoption forgets. Without it the next sweep sees a page it has no local document for and re-mirrors it, so the user ends up owning one copy and being served another.

### The document record (frontmatter, W1.5)

```ts
mirroredDocumentSchema = {
  docId:               string().length(16)   // sha256(kind:workspaceId:externalId).slice(0,16)
  title:               string().max(500)     // metadata, NOT the filename (Q12)

  // F1's nested provenance object, DEFINED IN F1 and referenced here (D17).
  // These ten members (the nine above plus `adoptedAt`, D24) are the entire
  // carry-through; F2 restates no flat list.
  source: {
    kind / connectionId: string()
    externalId:        string().min(1).max(200)  // opaque, survives rename + move
    url:               string()              // canonical remote URL
    remoteVersion:     string()              // Notion last_edited_time, the etag
    origin:            enum(['remote','local']).default('remote')   // 'local' means adopted
    state:             enum(['ok','conflict','tombstoned','truncated']).default('ok')
    mirroredAt:        string().datetime()   // STORED. Never recomputed on read (D8)
    lossy:             array(lossyKindSchema).default([])
  }

  // F2-local frontmatter: the sweep reads these through readMeta. F1 never
  // parses or republishes them, so they cannot drift between the two specs.
  collectionExternalId: string()
  parentExternalId:    string().optional()   // transcript to its summary
  docType:             enum(['page','row','section','transcript','summary']).default('page')
  remoteVersionSeen:   string()              // what the last CLEAN pull recorded
  localVersion:        string()              // sha256 of the local body bytes (files.ts:17-19)
  // NOTE: adoptedAt is NOT here. It is the tenth member of the nested `source`
  // object defined by F1 (plan D24), because it is provenance about the origin.
  properties:          Record<string, unknown>   // Notion select/date/person, flattened
  unresolvedComments:  int().default(0)
}
```

### The freshness model, and why it has no clock in it (D8)

`syncState` is a stored enum with a stored `syncStateAt`. Transitions are **writes**, made by exactly two writers:

- the **sync engine**, at sweep boundaries: `ok` on a complete sweep, `error` on a failed attempt, `unavailable` on a provider `{available:false}`, `paused` when the connection is disabled or archived;
- the **scheduler**, on its own tick, which is the only thing that may flip `ok` to `stale` (when `now - lastCompleteSweepAt > intervalSeconds * 3`) and it does so by persisting the field.

No handler reads the clock. Three identical GETs return three identical bodies because nothing between them recomputes anything, and the browser is free to render "2 hours ago" from `mirroredAt` because the browser is not the parity surface.

## API Contracts

### Wire schemas (`packages/contract/src/sources.ts`, scaffold-owned, specified here)

Closed schemas mirroring the open `.passthrough()` storage schemas, request bodies typed as `z.input`, responses as `z.infer`, following `packages/contract/src/automations.ts:11-22,260`. The package is Node-free by construction (its tsconfig has `types: []`), so a `node:*` import there is a compile error rather than a convention.

```ts
sourceAvailabilitySchema   = { available: boolean, reason?: string }
sourceCapabilitiesSchema   = { list, fetch, poll, push, comments: boolean }   // ALL required (Q3)
sourceSyncStateSchema      = enum(['never-synced','ok','stale','error','unavailable','paused'])

sourceProviderInfoSchema   = { kind, label, capabilities, availability, credentialHint }
sourceConnectionWireSchema = { ...definition fields, syncState, syncStateAt?, lastCompleteSweepAt?,
                               lastSuccessAt?, nextDueAt?, lastErrorMessage?, documentCount,
                               conflictCount, unresolvedComments, availability, complete: boolean }
sourceDocumentWireSchema   = { docId, externalId, title, docType, url, origin, state,
                               mirroredAt, syncState, lossy, properties,
                               body?: string }          // body only on the single-document route
```

This is F2's own route surface, flat by construction, and it is **not** F1's nested `source` object: F1 defines that object once (D17) and this spec references it rather than duplicating it, so nothing here is a second definition of the provenance the knowledge base carries. `mirroredAt` and `syncState` are **required** on the document wire schema. That is the enforcement mechanism for "a cached mirror never renders without saying how old it is": `contract-parity.sources.test.ts` asserts mutual assignability in both directions, so a handler that omits either fails `npm run typecheck` rather than shipping a document with no provenance. Both are stored values, so the guarantee costs nothing at request time (Q6).

### Routes: 13, project-scoped, all under `/api/v1`

| Method | Path | Notes |
|---|---|---|
| GET | `/sources` | connection list |
| POST | `/sources` | create. Typed body |
| PUT | `/sources/:connectionId` | update, revision-checked, 409 on mismatch. Typed body |
| DELETE | `/sources/:connectionId` | tombstone, never a hard delete |
| GET | `/sources/providers` | catalog with capability data and availability |
| GET | `/sources/:connectionId/collections` | browse the remote |
| POST | `/sources/:connectionId/sync` | manual kick, `202 {syncId}` |
| GET | `/sources/:connectionId/documents` | mirrored metadata, no bodies |
| GET | `/sources/:connectionId/documents/:docId` | one document, with body |
| POST | `/sources/:connectionId/documents/:docId/adopt` | the cutover |
| POST | `/sources/:connectionId/documents/:docId/resolve` | two actions. Typed body |
| GET | `/sources/:connectionId/comments` | the comment stream |
| GET | `/sources/:connectionId/log` | audit log, cursor plus limit at most 100 |

Registration is by chaining into one `sourcesRoutes` family builder mounted into `v1` (`server.ts:5083-5100`), never a loose `app.get`, because a loose registration serves correctly and vanishes from `AppType`, which is how PR #694 shipped eleven unreachable routes. Bodies, params and the query string are validated as route **middleware** through `jsonZodValidator` / `paramZodValidator` / `queryZodValidator` (`packages/cezar/src/server/validators.ts:88,152,160`), never a `safeParse` inside the handler, because Hono records a validated shape in the route type only when validation is middleware.

Three routes gain `Assert<HasTypedBody<...>>` rows in `typed-bodies.test.ts` (`POST /api/v1/sources`, `PUT /api/v1/sources/:connectionId`, `POST /api/v1/sources/:connectionId/documents/:docId/resolve`), matching the existing list shape at `typed-bodies.test.ts:34-62`. The mutators with no request body are not eligible for that assertion and are not listed. All 13 paths are added to BACKWARD_COMPATIBILITY.md section 2 by the scaffold; `bc-route-inventory.test.ts:119-137` fails otherwise, and `route-parity.test.ts:150-202` picks them up automatically because its manifest is derived from real registrations.

The workspace SSE vocabulary gains one name, `source-sync`, appended to `WorkspaceEventName` (`server.ts:477-482`). Widening that union is additive.

### Degradation with `CEZ_SOURCES` unset

The follow-up inbox shape, copied, and it is the plan's **D19** shape confirmed for this feature: routes always exist, GETs answer `200 []` or `200 {available: false, reason}`, mutators answer 409 with one named constant (`server.ts:393,4344` is the precedent), and **no handler in this family ever answers 404**. The feature is switched off, not missing: a 404 would tell a client that a route its generated `AppType` still holds does not exist, which breaks the typed client's own contract. No provider is constructed, no timer is armed, and the health payload is unchanged. `forgeInfoSchema` keeps `kind: z.literal('github')` and no source ever appears on `/api/v1/health`'s `forge` object. (The earlier design asserted `git diff packages/contract/src/health.ts` is empty; that is wrong, because the scaffold may add capability keys for sibling features. The correct, narrower assertion is the one above, on `forgeInfoSchema` specifically.)

## UI/UX

**Settings, then Sources** (one settings-registry entry, scope: project, scaffold-owned registration; the section itself is W4.8).

- **Connection list.** Each row carries a status badge driven by the stored `syncState` plus `mirroredAt`, the document count, the conflict count if any, and the next due time. `never-synced`, `stale`, `error`, `unavailable` and `paused` each render distinctly; a generic grey pill for all five is how a revoked token gets mistaken for an idle connection.
- **Provider picker.** An unavailable provider is rendered **greyed with its exact reason string in the DOM**, never hidden. Hiding it answers "why can I not add Notion?" with nothing.
- **No token field.** Anywhere. The only token-shaped thing on the page is a copyable hint naming `CEZ_NOTION_TOKEN` and its two fallbacks, plus the "share the page with the integration" step.
- **Collection browser.** A collection with zero documents while the connection is available renders the actionable empty state from the meeting-notes section, not the generic one.
- **Conflict resolver.** Exactly two actions: keep local (the remote body stays quarantined in `conflicts/` and `remoteVersionSeen` advances so the conflict does not re-fire), or take remote (the local body is moved aside first, never discarded). There is no merge and no third option.
- **`source-status-badge.tsx`** is shared, so the Knowledge surface renders a mirrored document's provenance with the same component and the two cannot disagree.

## Edge Cases and Failure Scenarios

- **No token.** `detect()` resolves `{available: false, reason}` and never throws or rejects. The connection keeps its documents and its stale badge.
- **Revoked token (401/403).** `syncState: 'unavailable'`, the mirror frozen in place, counts unchanged, the reason shown verbatim. This is the case that must never be indistinguishable from an empty workspace.
- **429 with `Retry-After`.** `backoffUntil` from the header, `complete: false`, zero tombstones, the tick ends cleanly.
- **Call budget exhausted mid-collection.** `complete: false`, `nextPageCursor` non-null, `pageCursor` persisted, watermark unchanged, zero tombstones. The next tick resumes and re-emits nothing from earlier pages.
- **A page over `maxBodyBytes`.** Split on H2 into `section` documents; `state: 'truncated'` on the parent if the split cannot bring a section under the cap.
- **A document renamed in Notion.** One frontmatter field changes. Zero file operations, zero git churn, zero re-index of the body.
- **A document moved between collections.** `collectionExternalId` changes; `docId` does not, because the hash is over the workspace and the opaque id, not the location.
- **Both sides changed.** Quarantine, and the sweep continues (Q14).
- **A document adopted, then edited on the remote.** The sweep skips it: it is in `adoptedExternalIds` and its file is no longer in the mirror root.
- **A document adopted, then the whole connection archived.** Zero remote mutations of any kind, ever (Q10).
- **`source-state.json` deleted or corrupt.** Degrades to empty plus one warning, and the next sweep is a full cold enumeration. Nothing is lost, because provenance lives in frontmatter.
- **`sources/` deleted entirely.** The next sweep rebuilds it. The mirror is explicitly a derived cache, which is what keeps the "no database" invariant honest.
- **Two cezar processes on one machine.** The lease serializes them.
- **Two machines on one repo.** Named as an unsolved risk below, not half-solved.
- **A collision on the truncated hash.** Two different `externalId`s producing one `docId` is a hard error with both ids in the message, never a silent overwrite.
- **A comment with an unreadable image attachment.** Recorded as `downloadable: false` and surfaced as a count.

## Phases

Each phase leaves the app fully working and ships independently. Step numbers map 1:1 onto the plan's work-package ids so a run PLAN.md can track them directly.

### Phase 1: leaves (plan W1.4, W1.5, W1.6, buildable in parallel)

**1.1 (W1.5)** `src/sources/types.ts`: storage zod schemas above (connection, collection ref, state, mirrored document, lossy kinds), the `SourceSink` port, and `MirroredDocumentMeta`. Every object `.passthrough()`, every field optional or defaulted. *Test:* round-trip; an unknown key survives; a required-looking new field added to the schema still parses an old file; `PROJECT_ID_RE` rejects a reserved id.

**1.2 (W1.5)** `src/sources/store.ts`: `sources.json` with revision plus tombstones, `source-state.json`, `source-log.ndjson` with `seq` plus compaction, the `O_EXCL` lease, the stored `syncState` transitions, and `adopt()`. *Test:* a corrupt `sources.json` yields an empty list plus one warning and never throws; one malformed row is dropped while siblings survive; no `.tmp` file remains after any write; `acquireLease()` twice returns a lease then `undefined`, and a lock older than 10 minutes is reclaimed; `JSON.stringify(store.list())` matches no key against `SECRET_NAME_RE`.

**1.3 (W1.5)** `src/sources/sink.ts`: `FileSourceSink`, one `<docId>.md` per document with YAML frontmatter carrying F1's nested `source` object (D17), `readMeta` as a bounded frontmatter-only read, `quarantine`, `tombstone`, `adopt` as a move into F1's writable knowledge root `.ai/cezar/knowledge/` (D16), `notifyChanged` as a no-op hook standalone. *Test:* changing only `title` performs zero file renames (`readdirSync` set-identical before and after); a divergent upsert writes `conflicts/<docId>.remote-<v>.md` and leaves the local body byte-identical; `adopt` removes the file from `sources/` and creates it under `knowledge/` with `source.origin: 'local'` and `adoptedAt` set, and no `adopted/` directory is created by any code path (`grep -rn "adopted/" packages/cezar/src/sources` returns nothing).

**1.4 (W1.4)** `src/sources/notion/client.ts`: `fetch` plus zod against `CEZ_NOTION_API_BASE` (default `https://api.notion.com`), `Notion-Version: 2022-06-28` on every request, database query and block-children enumeration following `next_cursor` until `has_more` is false, the per-connection token bucket, the call budget, and backoff. *Test:* every request carries the pinned version header and targets the configured base; no test performs live network I/O; with no token, `detect()` resolves `{available:false, reason}` and never rejects; a 401 resolves `{available:false, reason}`; a 429 with `Retry-After` yields a backoff hint and `complete: false`; `has_more: true` with the budget spent returns `complete: false` plus a non-null `nextPageCursor`.

**1.5 (W1.4)** `src/sources/notion/markdown.ts`: blocks to Markdown, `lossy[]` accounting, H2 splitting. *Test:* golden fixture round-trip for paragraphs, H1 to H3, lists, to-dos, quotes, fenced code with language, tables, links and inline marks; a fixture containing an image, a `synced_block` and a `column_list` yields `lossy` equal to `['image','synced_block','column_list']` and drops none of them silently; a page over `maxBodyBytes` splits on H2 into sections whose `externalId` is `<pageId>#<headingBlockId>` and is stable across a re-parse.

**1.6 (W1.4)** `src/sources/notion/comments.ts`: per-page comment listing, normalisation, unreadable-attachment recording. *Test:* a comment with an image attachment produces `{type:'image', downloadable:false}` and is never dropped.

**1.7 (W1.6)** `src/scheduling/due-scheduler.ts`: extract the earliest-due timer generic over an entry type from `WorkspaceAutomationScheduler` (`automations/scheduler.ts:158,187-204`) and make the automations scheduler use it. Pure refactor. *Test:* the existing `automations/scheduler.test.ts` cases (`:100-122`, "arms its first timer when a definition is enabled after startup", "keeps one timer when overlapping reschedules resolve out of order") stay green unchanged; `git diff packages/cezar/src/automations/types.ts` is empty.

### Phase 2: the provider (plan W2.2, depends on W1.4 and W1.5)

**2.1** `src/sources/provider-types.ts`: `SourceProvider`, `SourceKind` as a plain string with the comment stating why, `SourceCapabilities` with five required booleans, `SourceChangePage` with `complete` and `truncated`. *Test:* a capabilities object missing one boolean fails `parse`.

**2.2** `src/sources/registry.ts`: `SOURCE_PROVIDERS` and `resolveSourceProvider(connection, deps)`. *Test:* `resolveSourceProvider({kind:'nope'})` returns `null` and does not throw; `grep -rn "github.com\|parseRemote" packages/cezar/src/sources` returns nothing, so no git remote is consulted anywhere on this path.

**2.3** `src/sources/notion/provider.ts`: the adapter, `capabilities` declared as data with `push: false`, `detect` / `detectCached` following the forge behaviour, `pollChanges` propagating `complete`. *Test:* a 401 yields `changes: []` with `complete: false`, so a revoked token can never be read as an empty workspace.

### Phase 3: the engine (plan W4.4, depends on W2.2, W1.5, W1.6)

**3.1** `src/sources/sync.ts`: the ten-step sweep, including the `complete === true` tombstone gate, the diff-before-fetch skip, quarantine with a still-advancing watermark, and adoption skipping. *Test:* the four negative controls in Verification.

**3.2** `src/sources/coordinator.ts`: discover projects by the existence of `<root>/.ai/cezar/sources.json`, mirroring `automations/coordinator.ts:45`. *Test:* a project without that file is never discovered; no git remote is read.

**3.3** `src/sources/scheduler.ts`: one workspace-wide timer over `due-scheduler.ts`, `nextDueAt` and the `ok` to `stale` transition persisted as writes. *Test:* two connections across two projects produce exactly one `setTimeout`, set to the earlier due time; a 429 sets `backoffUntil` with jitter and the connection is skipped until it passes; with `CEZ_SOURCES` unset, zero timers are armed.

### Phase 4: surfaces (plan W4.6 and W4.8)

**4.1 (W4.6)** `src/server/sources-routes.ts`: the 13 handlers filling the scaffold's inert family, every one reading its state from `c.get('project')`. *Test:* with `CEZ_SOURCES` unset, `GET /api/v1/sources` answers `200 []`, `POST /api/v1/sources` answers 409, and no path in the family answers 404 (D19); `grep -n "bootContext\|bootStore" src/server/sources-routes.ts` returns nothing; `grep -n "Date.now()\|new Date()" src/server/sources-routes.ts` returns nothing (D8, structural); the single-document response carries both `mirroredAt` and `syncState`.

**4.2 (W4.8)** `packages/web/src/routes/settings/sources-section.tsx` and `packages/web/src/components/source-status-badge.tsx`. *Test:* an unavailable provider renders greyed with its exact reason string present in the DOM; the five `syncState` values render distinctly; `grep -n "token" sources-section.tsx` matches only the copyable `CEZ_NOTION_TOKEN` hint and no input element.

**Not in phase 1, deliberately:** write-back and push (Q9), asset downloading (Q16), any second provider, and cross-machine coordination.

## Risks

- **A partial pull is mistaken for a shrunken source and live documents are tombstoned.** This is not hypothetical: the false-empty ran ~45 consecutive ticks in this workspace. *Mitigation:* `complete` threaded provider to sync to store to wire, tombstoning gated on it, and a negative control with a stated mutation under which the test must fail (Verification NC-1).
- **A revoked token empties the mirror, so "you have no documents" and "cezar can no longer read your workspace" become one screen.** *Mitigation:* 401/403 sets `syncState: 'unavailable'` and freezes the mirror; counts never change; the reason is shown verbatim. Negative control NC-2.
- **The cold backfill never completes because every tick restarts.** ~1,319 rows plus a 783 KB page is 15 to 25 minutes of API calls; without resume, `lastCompleteSweepAt` is never written and nothing is ever safe to tombstone, permanently. *Mitigation:* `pageCursor` persisted per sweep. Negative control NC-3.
- **Both sides change and the mirror overwrites a locally edited document.** The exact data-loss class `CODE_REVIEW.md:58` calls a blocker. *Mitigation:* the three-field version model plus quarantine. Negative control NC-4.
- **One unresolvable document stalls a whole connection forever.** *Mitigation:* the watermark advances past a conflict, asserted directly.
- **The Notion token becomes the first credential cezar holds on disk.** *Mitigation:* environment only, no schema key, no UI field, plus a store-level test asserting no serialized key matches `SECRET_NAME_RE`.
- **Meeting notes, the motivating case, are invisible because an internal integration sees only shared pages.** *Mitigation:* a distinct, actionable reason string for "zero documents while available", rendered as its own empty state, and documented beside `CEZ_NOTION_TOKEN` in `.env.example`.
- **A second outbound integration inherits `GithubRequestArbiter`'s process-wide chain and one large page stalls the PR list, or shares nothing and doubles outbound concurrency nobody budgeted.** *Mitigation:* per-connection chain plus token bucket, never the arbiter; concurrency bounded by enabled connections, which default to zero.
- **Adding 13 routes half-wires the feature (the #694 shape: a loose `app.get` vanishes from `AppType`, a missing section 2 entry fails `bc-route-inventory`).** *Mitigation:* the scaffold owns `server.ts`, `typed-bodies.test.ts` and `BACKWARD_COMPATIBILITY.md` together, so the doc edit cannot lag the code into a different PR.
- **Two hosts or two cezar processes on different machines mirroring one repo double-write.** *Not mitigated, and scoped out explicitly.* The lease is an `O_EXCL` pid file with a 10-minute mtime reclaim and no fencing token, matching the automations precedent exactly and inheriting its stated limit. The mirror is idempotent by `docId`, so a double-write converges rather than corrupting, but a cross-machine coordination primitive is the thing that must exist before this runs on more than one host.
- **Upstream divergence.** This adds files to a repo whose `server.ts` upstream churns weekly. Every file in this feature except the scaffold's chokepoints is new, which is the cheapest merge shape available, and no Loki-specific string enters `src/` (plan D2).

## Verification

Gates green is necessary and not sufficient. What follows is written as negative controls: for each, the mutation that must make it fail is stated, because a control that passes with the mechanism disabled proves nothing and should be deleted rather than trusted.

### Negative controls

**NC-1, the pagination gate (the headline).** Fixture: `pollChanges` over two pages, page 1 holding document A, page 2 holding B; the mirror already holds A, B and C. A sweep run with a one-page call budget must return `complete: false` and a non-null `nextPageCursor`, emit A only, **tombstone nothing**, leave the watermark unchanged, and persist `pageCursor`.
> **Must fail when:** the `if (!allComplete) return` guard before the tombstone pass in `sync.ts` is removed. Under that mutation the test fails by tombstoning B and C. If the test still passes with the guard removed, the guard is decorative and this control is invalid.

**NC-2, the revoked token.** Seed a mirror with N documents, stub a 401 on the next poll. Assert `documentCount` is exactly N afterwards, `syncState === 'unavailable'`, the reason string is present verbatim, and zero tombstones were written.
> **Must fail when:** the Notion provider's 401 path returns `{changes: [], complete: true}` instead of `complete: false`. Under that mutation the sweep tombstones every document and the count assertion fails. This is the single most destructive plausible bug in the feature, so it gets its own control rather than riding on NC-1.

**NC-3, resumability.** Run a sweep with a one-page budget, then run a second tick. The second tick must emit page-2 documents and re-emit **zero** page-1 documents, asserted on the sink's `upsert` spy call list, not on a count.
> **Must fail when:** `pageCursor` is not persisted (the store write is commented out). Under that mutation the second tick re-emits page 1 and the spy list assertion fails.

**NC-4, conflict quarantine.** Mutate both sides: change the local bytes on disk and deliver a newer `remoteVersion`. Assert the local body is byte-identical to what was written locally, `conflicts/<docId>.remote-<v>.md` exists with the incoming body, `state === 'conflict'`, **and the watermark advanced**.
> **Must fail when (either direction):** the sink writes the incoming body over the local file (the byte-identity assertion fails), or the sweep returns early on a conflict (the watermark assertion fails). Both directions are asserted, because the two bugs have opposite shapes and a control for only one of them is half a control.

**NC-5, identity is not the title.** Change only a document's `title` and re-run the sweep. `readdirSync(dir)` must be set-identical before and after.
> **Must fail when:** the sink names files from a slugified title. Under that mutation the directory listing changes and the assertion fails.

**NC-6, no clock in a GET (D8).** Issue `GET /api/v1/sources` and `GET /api/v1/sources/:id/documents/:docId` three times each against a seeded store, advancing the fake clock past `intervalSeconds * 3` between calls, and assert all three bodies are byte-identical.
> **Must fail when:** `syncState` is computed in the handler from `Date.now()` and `lastCompleteSweepAt`. Under that mutation the second and third bodies differ and the assertion fails. Backed structurally by `grep -n "Date.now()\|new Date()" packages/cezar/src/server/sources-routes.ts` returning nothing.

**NC-7, no credential reaches disk.** After exercising create, update and a full sweep, assert that no key in the serialized `sources.json` or `source-state.json` matches `SECRET_NAME_RE` (`packages/cezar/src/core/secret-redaction.ts:28-29`), and that the token value itself appears in neither file.
> **Must fail when:** the connection schema gains a `token` field. Under that mutation the key assertion fails.

**NC-8, flag-off inertness (D19).** With `CEZ_SOURCES` unset: `GET /api/v1/sources` answers `200 []`, `POST /api/v1/sources` answers 409, **no route in the family answers 404** (asserted over all 13 paths, not only the two sampled above), zero timers are armed, and `/api/v1/health` is byte-identical to the pre-change payload.
> **Must fail when:** the gate is written as `!== '0'`. Under that mutation the POST answers 201 and the assertion fails.

**NC-9, the automations refactor is pure.** `npm test -w @open-mercato/cezar` filtered to `automations` passes unchanged, and `git diff packages/cezar/src/automations/types.ts` is empty.
> **Must fail when:** `ProjectAutomationHandle` or `automationEventSchema` is widened to admit a non-git source. That is the change this control exists to forbid.

**NC-10, the forge contract is untouched.** `packages/contract/src/health.ts` still contains `kind: z.literal('github')` inside `forgeInfoSchema`, and no source kind appears on the health payload.
> **Must fail when:** a source kind is reported through `forge`. (Stated narrowly on purpose: asserting the whole file is unchanged is wrong, because the plan's scaffold may add sibling capability keys to it.)

### Validation

The gate is exactly five commands, in this order, declared once in `.ai/agentic.config.json:8-16`. **There is no lint step and no format step in this repo.**

```bash
npm run typecheck    # also what enforces contract-parity in BOTH directions and typed-bodies
npm test
npm run test:unit
npm run build
npm run test:package
```

`npm run typecheck` is the one that matters most here: `contract-parity.sources.test.ts` and `typed-bodies.test.ts` are compile-time assertions, so a handler that omits `mirroredAt` or `syncState`, or a route registered without chaining, is a red typecheck rather than a runtime surprise. `npm test` is what runs `bc-route-inventory.test.ts`, `route-parity.test.ts` and `versioned-surface.test.ts` over the built app's real route table.

Additionally, and **run only by the plan's W5.1**, never by any package here (one browser, one port 4321, one `.ai/qa/test-env.lock`, `fileParallelism: false`):

```bash
npm run test:e2e     # TEST_E2E_STATUS=skipped is NOT a pass
```

No test in this feature performs live network I/O. The Notion suite runs entirely off recorded fixtures against `CEZ_NOTION_API_BASE` pointed at a local stub.

## Open questions for the owner

1. **Where should an adopted document land? RESOLVED, not open.** Plan **D16** settles it: F1's writable knowledge root, `<repoRoot>/.ai/cezar/knowledge/`, in every configuration, `CEZ_KB` on or off, and the `adopted/` root this spec previously proposed does not exist. The remaining owner choice is only whether that root is *additionally* mirrored into `docs/` later, which is additive and does not have to be settled before the first adoption.
2. **Should `watchComments` default on for a connection that has any comments?** It defaults off here because comment sweeping is one API call per document per tick and is the only unbounded-ish cost in the design. Turning it on by default would make the second human's contributions visible without anyone remembering to ask for them, which is the argument the other way.
3. **Cross-machine coordination.** Named in Risks as unsolved. If cezar is ever going to mirror one repo from two hosts, the `O_EXCL` lease needs replacing with a leased primitive carrying a TTL and a fencing token, and that decision should be made before the second host exists, not after.
