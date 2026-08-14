# Plan: cezar as the central hub

**Status:** proposed, not started
**Owner:** Marcin Walendowski
**Base:** `main` (fork `MarcinWalendowski/cezar`, currently 0 ahead / 0 behind `open-mercato/cezar@d3aff0a`)
**Specs (authoritative; this plan maps their steps 1:1 onto the package table):**

| Spec | Feature | Upstream? |
|---|---|---|
| `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` | F1 Knowledge base | yes |
| `.ai/specs/2026-08-06-external-source-connectors-notion.md` | F2 Source seam + Notion provider | yes |
| `.ai/specs/2026-08-06-workspace-notes-cross-project.md` | F3 ~~Notes to multi-project tasks~~ (**feature B REMOVED 2026-08-14**, `.ai/specs/2026-08-14-remove-notes-capture-inbox.md`), cross-project views (feature A, still current) | yes |
| `.ai/specs/2026-08-06-pluggable-notification-transports.md` | F4 Notification transports | yes |
| `.ai/specs/2026-08-06-ops-board-notion-cutover.md` | F5 Ops board, Notion migration, multi-player | **no, fork-private** |
| `../../chat/.ai/specs/SPEC-417-2026-08-06-cezar-notification-agent.md` | F6 `agt_cezar` + `/notify/v1` ingress | n/a (chat repo) |

---

## Why this plan exists

Three independent design passes produced 15 files claimed by more than one work package,
three incompatible document schemas for the same object, and one gap that would have
shipped the feature broken: **F2 mirrored Notion into a directory F1 never read.** This
plan is the single authority that resolves those. A dispatched agent reads its spec plus
this file, and never re-derives a decision recorded here.

---

## Resolved decisions (autonomous defaults)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Is cezar the right host at all? | **Yes, by owner decision.** Concern recorded, not re-litigated. | cezar carries a real tax: a published npm package, nine mechanically-guarded protected surfaces, both-direction contract parity, a hand-maintained route inventory, a hard `qa-approved` merge gate, and a `server.ts` that upstream churns weekly. That tax is correct for a general-purpose orchestrator and buys nothing for a private board. It is paid here deliberately, and D2 is what keeps the bill finite. |
| D2 | What goes upstream? | **F1 to F4 are generic and upstreamable. F5 is fork-private. No Loki string ever enters cezar `src/`.** | The features a cezar user would want (a knowledge base, external sources, a notes inbox, cross-project views, notifications) are separable from the things only this workspace wants (a Loki ticket board, importers for five specific Notion databases, a reporter-notification call into an iMessage bot). Mixing them is what makes a fork unmergeable forever. |
| D3 | Mount the corpus or import it? | **Decided by origin, not preference. Files on disk are mounted read-only. Content that is not a file (Notion pages) is mirrored to disk by F2, and the mirror root is registered as an F1 mount.** | This is the wire the three designs left unconnected. Mounting gives zero migration and zero drift for the 429 specs and the docs that change daily; a Notion page has no file to mount, so it must be materialised first. One store reads both. |
| D4 | Default on or off? | **Every flag is off unless it is the exact string `'1'`.** `CEZ_KB`, `CEZ_SOURCES`, `CEZ_NOTES`, `CEZ_WORKSPACE_VIEWS`, `CEZ_NOTIFY`, `CEZ_OPS`. Unset means the feature does not exist: no index built, no nav item, no prompt bytes, no background timer. | Overrides the KB design's `!== '0'`, which meant unset equals on. Combined with its auto-discovery that reached `~/.claude/projects/<slug>/memory`, the default install would have begun serving the contents of a personal memory store over HTTP, and over the network in remote mode. `CODE_REVIEW.md` lists "server exposed beyond localhost" as a merge blocker. |
| D5 | Auto-discover roots outside the project? | **Never.** Only the project root and paths explicitly listed in config are indexed. | Same reason as D4. A path the user did not name is a path the user did not consent to serve. |
| D6 | How is parallelism made safe? | **One solo scaffold package owns every shared file, once. Every other package owns only files it creates.** | Fan-out collides at file level, not topic level. The 15 collisions were all in eleven shared files; a scaffold makes them unreachable rather than merely discouraged. |
| D7 | New runtime dependencies? | **None.** Budget stays hono, @hono/node-server, yaml, zod, smol-toml, ws. Everything uses native `fetch` and the existing `yaml`. | `CODE_REVIEW.md` makes widening it an explicit review decision, and a new dep in a KB PR is a second argument to lose. |
| D8 | Clock-derived fields in a GET body? | **Forbidden.** Freshness is expressed as a stored timestamp plus a stored state, never as an age computed at request time. | `route-parity.test.ts` issues the same GET three times and compares bodies byte-for-byte. A field that straddles a threshold between two of them is a flaky red gate that gets debugged as alias drift. |
| D9 | Where does PII live? | **Never in a cezar directory that is committed.** Report bodies carry phone numbers, chat ids and agent ids; the F5 board lives in a private repo with its own remote. | A phone number pushed to a git remote is unredactable and permanent. |
| D10 | Search default | **BM25 with exact-identifier pinning.** Embeddings strictly behind `CEZ_KB_EMBEDDINGS=1`, and the package that creates the blob also gitignores it in the same commit. | Measured, with its scope stated: a BM25 index over a 754-file / 7.2 MiB slice built in ~146 ms for ~5 MB resident, which is why nothing durable is persisted and the "no database" invariant holds trivially. **That slice is not the real corpus.** Counted directly on 2026-08-06: 932 markdown files / 12.4 MiB workspace-wide (433 in `chat/.ai/specs`, 268 Claude memory notes), excluding worktrees and `node_modules`, and *before* the 3 to 5 MB of mirrored Notion content this programme exists to absorb. Three agents produced three different corpus counts from three different exclusion sets, which is the tell. So the headroom is real but the number is provisional: **W2.1 must re-measure at full corpus size including a populated mirror, and the spec must state the measured figure and the truncation behaviour rather than inheriting this one.** Separately and independently verified: BM25 alone failed `SPEC-282` lookup entirely (a cross-referenced identifier has low IDF), which is why pinning is load-bearing and carries a negative control. The embeddings blob is 17 MB; the design that introduced it could not touch `ensureDataGitignore`, so enabling it would have committed 17 MB into the user's repo. |
| D11 | Transport types or transport instances? | **AMENDED 2026-08-06 by D23, read that row instead of this one.** Instances, yes, and that part stands: one generic `webhook` transport, N instances in `~/.cezar/notifications.json`, each with its own `enabled`, endpoint, event matrix and rate limit. **The superseded half is the Loki shape:** this row originally said "iMessage, Telegram and WhatsApp are three rows", and that is wrong. Loki is **one** row whose config carries a `transports` array, because its endpoint fans out server-side (D23). | Satisfies "each can be enabled independently" exactly, generalises to a fourth, and keeps 100% of the code upstreamable with 0% of it naming Loki. The body template with a closed placeholder set is the single thing that decides fork versus config. |
| D12 | WhatsApp in phase 1? | **SUPERSEDED 2026-08-06 by an owner decision: YES, WhatsApp ships.** All three transports go through `lokimessages.com`, so at the cezar boundary they are one endpoint plus one API key and the choice of channel is a string in the `transports` array. **The superseded answer was "No, blocked on the session window and template approval."** That reasoning was scoped wrongly: it is a platform-side constraint, not a cezar-side one, and it does not gate cezar at all. It survives only in SPEC-417 as a per-transport result value (`window_closed`), reported in the result array like any other non-delivery. | Original reasoning, kept for the record: notification traffic is outbound and unsolicited, which is what the 24-hour window forbids, and shipping half-configured produces silent non-delivery. What that missed is the layering. cezar POSTs one request to one ingress; whether a given channel can deliver right now is the receiver's answer to give, and the per-transport result array already exists to give it. |
| D13 | Is a task a run? | **No. F3 keeps runs as runs. F5 introduces `ticket` as a separate durable entity.** | `RunRecord` is the run's prompt and lifecycle; `todos.json` is a delete-on-check list that is gitignored by contract. Neither models a backlog row that exists before it runs and after it finishes. Overloading either is how the board and the executor become the same broken thing. |
| D14 | Where do notes live? | **Workspace scope (`~/.cezar/`), never a project.** | A note's value is that it has not yet been assigned to a repo, and the user asked for org/team-level notes. Also mechanical: a note fanning out to three projects would have `resultingTasks` pointing into three different `runs.json` files while living in only one of them. |

### Added after the cross-spec check (D15 to D22)

The first six specs agreed on the headline of D3 and then disagreed on four details of it. These
decisions close that, and they are the reason the fan-out is safe to run.

| # | Question | Applied default | Why |
|---|---|---|---|
| D15 | Who owns the index and the change detection over mirrored bytes? | **F1 owns both, and there are two triggers, not one.** F1 runs the single `fs.watch` with debounce over every root including the mirror root, **and** exposes `notifyChanged(root)` which F2 calls after each sync batch. F2 builds no index and holds no watcher. | The specs deadlocked: F2 delegated the watcher to F1, and F1 specified no watcher at all, so F2's fallback rested on nothing. Two triggers rather than one because `fs.watch` is unreliable for bulk writes and inconsistent across platforms, which is exactly the shape of a sync batch. |
| D16 | Where does an adopted document land? | **In F1's writable knowledge root. There is no `adopted/` directory.** Adoption moves the bytes into `.ai/cezar/knowledge/` and flips `origin` to `local`. | F2 assigned a `SourceSink` implementation to F1 that F1 never mentions, writing into an `adopted/` root that appears in no roots table. As written, an adopted document would land in a directory nobody indexes. One writable root removes the whole class. |
| D17 | What provenance does a knowledge document carry? | **One nested `source` object holding the full mirror field set** (`kind`, `connectionId`, `externalId`, `url`, `remoteVersion`, `origin`, `state`, `mirroredAt`, `lossy[]`), not three flat fields. It is named once, in F1, and F2 references it. | F2 required 18 fields carried through; F1 declared three differently-named ones. `.passthrough()` preserves the bytes on disk but not the wire, so search results and the API would silently drop exactly the conflict-detection state F2 exists to produce. |
| D18 | Are the mirror's sub-directories indexed? | **No.** `conflicts/` and `deleted/` under any mirror root are excluded by name, in F1's exclusion list. | Neither spec excluded them. As written, a quarantined remote body would surface as a duplicate document beside its live original, and a tombstoned document would stay searchable for its full 90-day retention. A knowledge base that returns the deleted copy is worse than one that returns nothing. |
| D19 | What does a route answer when its flag is off? | **`GET` returns 200 with an empty payload; every mutator returns 409. Never 404.** The feature is switched off, not missing. | Four specs said this and one said every handler answers 404. The scaffold builds all five inert families in one package and cannot pick both. 404 is also the wrong claim: it tells a client the route does not exist, which breaks the typed client's own contract. |
| D20 | Does D8 bind the ops lease too? | **Yes, with no exception.** A lease's `state` is a persisted enum written by a transition, and `GET /ops/leases` may not filter its row set by a clock. | F5 called the field stored while deriving it at read time from `expiresAt`. Naming it stored does not make it stored: two identical GETs straddling the TTL return different bodies, which is precisely the flaky `route-parity` red gate D8 exists to prevent, and which F5's own assumptions table forbids elsewhere. |
| D21 | How are targeted tests invoked? | **`npm test -- <path>`. Never `npx vitest`.** | `cezar/AGENTS.md:99` states it as a rule. Five specs complied; one used `npx vitest run` seven times. A dispatched agent copies the command it is given. |
| D23 | One cezar transport row for Loki, or three? | **One row, named `loki`, posting to `POST /notify/v1/events`.** Its config carries a `transports` array. **That array NARROWS, it does not enable:** naming a channel in it is necessary and not sufficient, because the authority on whether a channel is on is the receiver's own `notify_targets.enabled` plus that channel's enrollment (SPEC-417). Omitting the array means every enabled channel. A channel named but disabled or unenrolled comes back `disabled` / `not_enrolled` in the per-transport result array, and the call still answers 202 with nothing delivered. The generic seam still supports N instances (a separate ntfy or Slack row is a second instance); Loki is one instance because its endpoint fans out server-side. **D11 is amended accordingly**: instances, yes, and an instance whose endpoint fans out carries its own per-channel enable list. | The two specs described two different config files. Three rows would post the same event three times to one ingress, giving three dedupe keys for one notification and splitting the idempotency domain that SPEC-417's `dedupeKey` exists to hold. It would also have put a cezar-side enable flag alongside the receiver's, and a setting stored in two places is a setting that does not apply. **Be precise about what this does and does not fix**, because the first draft of this row overclaimed: it removes cezar's per-row duplication, and it leaves one deliberate split, the narrowing array here versus `notify_targets.enabled` there. That split is correct rather than accidental (only the receiver can know whether a channel is enrolled, and enrollment is per transport and manual), but it means the owner's ask is satisfied by membership **plus** enrollment, not by membership alone. Any spec or UI that says "add it to the array and it is on" is wrong and must say "and it must already be enrolled". |
| D24 | Where does `adoptedAt` live? | **Inside the nested `source` object**, and it is added to D17's field list, which becomes ten members. | It is provenance about the mirrored origin, so it belongs with the rest of it. The two specs put it in two different places (F1 inside, F2 at top level) and D17's own list named it in neither, which is precisely the drift D17 was written to prevent. Naming it once is the whole mechanism. |
| D25 | What is `notifyChanged`'s signature? | **`notifyChanged(root: string, docIds?: readonly string[])`.** Root is required because F1 indexes by root; `docIds` is optional and narrows the reindex when the caller knows what changed. | F1 exported `notifyChanged(root)` and F2 declared `notifyChanged(docIds)`, reconciled in prose as "the same call bound to that sink's root". Prose reconciliation is not a signature, and an implementer would have had to pick one and silently break the other caller. |
| D22 | Two scoping corrections to the package table | **(a)** W3.1's dependencies include W1.7 and W2.5, because its own title requires it to register the notification runtime. **(b)** F5's phase-3 scaffold package is **granted** the chokepoint files by exception. **(c)** `packages/web/src/components/project-groups.tsx` and `packages/web/src/routes/tasks-overview.tsx` belong to W1.1. | (a) was an omission in the deps list. (b) is a letter violation of D6 that is safe because phase 3 is temporally separate from phase 1, so D6's actual purpose (never two concurrent agents in one file) holds; granting it explicitly beats leaving a spec quietly contradicting the authority. (c) two files were touched by a spec and owned by no package, which is how a file ends up edited twice. |
| D26 | Does P5.4 (`cezar/.ai/specs/2026-08-06-inbound-agent-control-channel.md`, the poller package) get W1.1's chokepoint files? | **Granted, named exception, the same form D22(b) uses.** P5.4 is **granted** `packages/cezar/src/server/capabilities.ts` and its test, `.env.example`, `BACKWARD_COMPATIBILITY.md`, and `packages/contract/src/health.ts` (a `command` capability boolean lands on `capabilitiesSchema` there, the same precedent the notes spec follows). **Sequencing condition, load-bearing:** P5.4 takes **W1.1 as a dependency**. It may not start until W1.1 has landed, so the two packages never touch these files concurrently. | D6 is keyed on files, not routes, so "P5.4 creates no route" does not clear it of the chokepoint files it does touch; a spec may not assert its own exemption. The grant is safe for the same reason D22(b) is: W1.1 having landed first makes the two packages temporally separate, so D6's actual purpose (never two concurrent agents in one file) holds even though the letter of "every other package owns only files it creates" does not. Without the W1.1 dependency this row would not be safe to grant. |

---

## Phases

```
PHASE 4 (chat repo, no cezar collision) ─────────────────────────► runs in parallel throughout
   agt_cezar + /notify/v1 ingress + iMessage + Telegram

PHASE 1  MVP ──────────────► PHASE 2 ──────────► PHASE 3
   KB + Notion mirror          Notes to            Ops board,
   + notifications             multi-project       Notion cutover,
                               tasks + cross-      multi-player
                               project views       (fork-private)
```

**Phase 1 is the MVP** and is worth shipping alone: a Knowledge section indexing the repo
corpora with identifier-aware search, a read-only Notion mirror (so transcribed meeting
notes are visible in cezar), agent access to both, and push notifications so a VPS run
can reach a phone.

**Phase 3 carries every unresolved risk** and must not start before its two preconditions
land: the `report_issue` D1 dual-write (7-day agreement window, see W1.9) and an owner
decision on the auth model for a shared instance.

---

## Package table

Legend: **SOLO** = orchestrator only, never dispatched in parallel. Size S/M/L = 0.5/1/2.5 ideal agent-days.

### Wave 0: authority (SOLO)

| id | title | owns | size |
|---|---|---|---|
| W0.1 | Spec set: the five cezar specs + the chat spec | the six spec files listed at the top | M |

Dependencies: none. Nothing else may start until the slugs exist, because cezar has **no
spec-number allocator** (`tools/next-spec` does not exist here; date plus slug is the whole
identity) and two agents minting a name in the same minute collide silently.

### Wave 1: scaffold and independent leaves

| id | title | owns (exact) | deps | size |
|---|---|---|---|---|
| **W1.1** | **SCAFFOLD (SOLO)**: contract domains, inert flag-gated route families, every chokepoint edit | `packages/contract/src/{knowledge,sources,notes,workspace-runs,notifications}.ts` (new), `packages/contract/src/index.ts`, `packages/contract/src/health.ts`, `packages/cezar/src/server/server.ts`, `packages/cezar/src/server/{knowledge,sources,notes,workspace-runs,notifications}-routes.ts` (new, inert), `packages/cezar/src/server/contract-parity.{knowledge,sources,notes,workspace-runs,notifications}.test.ts` (new), `packages/cezar/src/server/typed-bodies.test.ts`, `packages/cezar/src/server/capabilities.ts` + test, `packages/cezar/src/index.ts`, `packages/cezar/src/paths.ts` + test, `packages/cezar/src/workspace/config.ts` + test, `packages/web/src/components/nav-items.ts` + test, `packages/web/src/routes.tsx`, `packages/web/src/api/client.ts`, `packages/web/src/api/queries.ts`, `packages/web/src/routes/settings/registry.tsx`, `BACKWARD_COMPATIBILITY.md`, `AGENTS.md`, `README.md`, `.env.example` | W0.1 | L |
| W1.2 | KB format adapters (markdown, loki-spec, cezar-spec, claude-memory) | `packages/cezar/src/knowledge/{parse,adapters}.ts` + tests | W1.1 | M |
| W1.3 | KB search and link graph | `packages/cezar/src/knowledge/{search,links}.ts` + tests | W1.1 | M |
| W1.4 | Notion HTTP client and block-to-Markdown | `packages/cezar/src/sources/notion/{client,markdown,comments}.ts` + tests + `fixtures/` | W1.1 | L |
| W1.5 | Source mirror store, file sink, freshness | `packages/cezar/src/sources/{store,types,sink}.ts` + tests | W1.1 | L |
| W1.6 | Due-scheduler extraction (pure refactor) | `packages/cezar/src/scheduling/due-scheduler.ts` + test, `packages/cezar/src/automations/scheduler.ts` | W1.1 | S |
| W1.7 | Notifier core: interface, registry, pure decider | `packages/cezar/src/notifications/{types,registry,decider}.ts` + tests | W1.1 | M |
| W1.8 | Notification config store, secret resolution, env bootstrap | `packages/cezar/src/notifications/{config,secrets}.ts` + tests | W1.1 | M |
| W1.9 | **chat repo**: `report_issue` D1 dual-write | `chat/domains/chatbots/worker/src/tools/report-issue.ts`, `.../src/env.ts`, `.../wrangler.jsonc`, `.../migrations/` (new), one new `chat/.ai/specs/SPEC-NNN-*.md` (allocate NNN with `chat/tools/next-spec` at write time, never from `ls`) | none | M |
| W1.10 | KB cockpit leaf components (presentational only) | `packages/web/src/routes/knowledge/{document,editor,backlinks}.tsx` + tests | W1.1 | M |
| W1.11 | `WorkspaceRunIndex`: read N projects' run stores without instantiating them | `packages/cezar/src/workspace/run-index.ts` + test | W1.1 | M |

> **W1.9 starts first and finishes last.** Its acceptance needs 7 consecutive days of exact
> Notion-and-D1 agreement, making it the longest-lead item in the whole plan. It gates the
> phase 3 cutover, not the MVP. Correction to an earlier assumption: the chatbots worker has
> **no `d1_databases` binding and no `migrations/` directory**, so this package must add both.

### Wave 2: composed cores

| id | title | owns | deps | size |
|---|---|---|---|---|
| W2.1 | KB storage core, catalog cache, containment rules | `packages/cezar/src/knowledge/{types,paths,catalog,store}.ts` + tests | W1.2 | L |
| W2.2 | `SourceProvider` seam, registry, Notion provider | `packages/cezar/src/sources/{registry,provider-types}.ts`, `sources/notion/provider.ts` + tests | W1.4, W1.5 | M |
| W2.3 | KB cockpit shell | `packages/web/src/routes/knowledge/{knowledge,knowledge-loading}.tsx` + test | W1.10 | M |
| W2.4 | Generic webhook transport, body templating, transport testkit | `packages/cezar/src/notifications/transports/webhook.ts`, `notifications/testkit.ts` + tests | W1.7 | M |
| W2.5 | Durable outbox, cross-process lease, retry with backoff and jitter | `packages/cezar/src/notifications/{outbox,sender}.ts` + tests | W1.7 | M |
| W2.6 | KB embeddings (optional upgrade, gitignore in the same package) | `packages/cezar/src/knowledge/embeddings.ts` + test | W1.3 | M |

### Wave 3: activation (SOLO)

| id | title | owns | deps | size |
|---|---|---|---|---|
| W3.1 | Hang `knowledgeStore` / `sourceStore` on `ProjectContext`; register notifier + run-index at workspace level | `packages/cezar/src/server/project-context.ts` + test | W2.1, W1.5, W1.11, W1.7, W2.5 (per D22a) | S |

Sole editor of `project-context.ts`. Nothing below compiles until the stores are reachable
from `c.get('project')`.

### Wave 4: feature bodies

| id | title | owns | deps | size |
|---|---|---|---|---|
| W4.1 | KB HTTP handlers (fills the inert family) | `packages/cezar/src/server/knowledge-routes.ts`, `knowledge-api.test.ts` | W3.1, W2.1, W1.3 | M |
| W4.2 | KB agent path: prompt block, write-back proposals | `packages/cezar/src/knowledge/{prompt,proposals}.ts` + tests, `packages/cezar/src/workflows/run.ts`, `packages/cezar/src/core/agent-env.ts` | W2.1 | M |
| W4.3 | `cez kb` CLI | `packages/cezar/src/knowledge/cli.ts` + tests | W2.1, W1.3 | M |
| W4.4 | Sync engine, coordinator, scheduler | `packages/cezar/src/sources/{sync,coordinator,scheduler}.ts` + tests | W2.2, W1.5, W1.6 | L |
| W4.5 | Store observer: run transitions to notifications, off the run's critical path | `packages/cezar/src/notifications/observer.ts` + test | W1.7, W2.5 | M |
| W4.6 | Sources HTTP handlers | `packages/cezar/src/server/sources-routes.ts`, `sources-api.test.ts` | W3.1, W4.4 | M |
| W4.7 | Notifications HTTP handlers + CLI | `packages/cezar/src/server/notifications-routes.ts`, `notifications-api.test.ts` | W2.4, W2.5 | M |
| W4.8 | Sources cockpit (Settings, Sources) | `packages/web/src/routes/settings/sources-section.tsx` + test, `packages/web/src/components/source-status-badge.tsx` + test | W1.1 | M |
| W4.9 | Notifications cockpit (Settings, Notifications) | `packages/web/src/routes/settings/notifications-section.tsx` + test, `packages/web/src/components/transport-health.tsx` + test | W1.1 | M |
| W4.10 | Workspace runs route + cross-project board + shared `ProjectFilter` | `packages/cezar/src/server/workspace-runs-routes.ts` + test, `packages/web/src/routes/workspace/{workspace-tasks,workspace-filter-state}.*`, `packages/web/src/components/project-filter.tsx` + tests | W3.1, W1.11 | L |

### Wave 5: verification and release (SOLO)

| id | title | owns | deps | size |
|---|---|---|---|---|
| W5.1 | e2e suite (**exclusive**: one browser, port 4321, `.ai/qa/test-env.lock`, `fileParallelism: false`) | `packages/web/e2e/{knowledge,sources,notifications,workspace-tasks}.e2e.ts` | all of wave 4 | M |
| W5.2 | Final gate, CHANGELOG, QA evidence | `CHANGELOG.md` | W5.1 | S |

**No package other than W5.1 may run `npm run test:e2e`.** It is a global mutex.

### Phase 2 (after MVP ships): notes to multi-project tasks

| id | title | owns | deps | size |
|---|---|---|---|---|
| P2.1 | Note store + workspace home paths | `packages/cezar/src/notes/{types,store}.ts` + tests | W1.1 | M |
| P2.2 | Note processor: one-pass, board-aware, catalog-constrained | `packages/cezar/src/notes/{coordinator,processor,prompt}.ts` + tests | P2.1, W1.11 | L |
| P2.3 | Notes routes, cross-project launch, run provenance | `packages/cezar/src/server/notes-routes.ts`, `packages/cezar/src/notes/task-template.ts` + tests | P2.2, W3.1 | M |
| P2.4 | Notes cockpit: inbox, capture box, review screen | `packages/web/src/routes/notes/*` + tests | P2.3 | M |
| P2.5 | `cez note` CLI | `packages/cezar/src/notes/cli.ts` + test | P2.1 | S |

### Phase 3 (fork-private): ops board, cutover, multi-player

| id | title | size |
|---|---|---|
| P3.1 | Ops entity store: ULID ids, per-entity files, derived index, tombstones | L |
| P3.2 | Git transport and push-as-CAS lease (TTL, holder record, heartbeat, fencing token) | M |
| P3.3 | Notion importers reusing the W1.4 client (tickets, knowledge split, capture, changelog) | L |
| P3.4 | Reconciler: census, per-row digest diff, behavioural replay with red controls | L |
| P3.5 | Mirror engine: per-surface authority, reversible by config, drift reporting | M |
| P3.6 | Ops cockpit + `cez ops` CLI + lease-aware dispatch | M |
| P3.7 | Skill and doctrine rewrite (workspace repo, SOLO) | M |

### Phase 4 (chat repo, parallel from day one)

| id | title | deps | size |
|---|---|---|---|
| P4.1 | Spec + Notion row for the cezar notification agent | none | M |
| P4.2 | Platform: notify subscriber/target schema + resolution service | P4.1 | M |
| P4.3 | Close the fail-open key scope, in both directions | P4.1 | M |
| P4.4 | Platform: per-transport fan-out service | P4.2 | M |
| P4.5 | Platform: `POST /notify/v1/events` ingress + health endpoint | P4.3, P4.4 | M |
| P4.6 | chatbots: typed no-conversation instead of a 500 from `/notify` | P4.1 | S |
| P4.7 | Provision `agt_cezar`: seed script + runbook | P4.2 | M |
| P4.8 | Per-agent Telegram credentials | P4.5, P4.7 | M |
| P4.9 | WhatsApp session window and template send: **blocked on D12** | P4.5 | M |
| P4.10 | E2E matrix per transport + weekly canary | P4.5, P4.6, P4.7 | M |

---

## The dispatch contract

Every parallel agent gets this verbatim. It is not boilerplate; each clause exists because
something broke without it.

1. **Do NOT run the full gate. The orchestrator runs it once per wave, on a quiescent tree.**
   `npm run typecheck` has `"pretypecheck": "npm run build:server"`, which writes
   `packages/cezar/dist`, and `npm run test:package` packs a tarball into the same place. Two
   agents running either one in the same checkout corrupt each other. **Amended 2026-08-06:**
   this clause first said "your own git worktree, your own `npm ci`", which is correct in
   principle and impractical at this fan-out (dozens of full `node_modules` trees), and worse,
   the harness's own worktree isolation cuts the *outer* workspace repo, not the cezar repo
   inside it, so asking for it would have silently given agents the wrong checkout. What you
   may run instead: **targeted vitest only**, `npm test -- <your test path>`, which triggers no
   pretypecheck and writes no shared artefact. Everything else waits for the barrier.
2. **The gate the orchestrator runs is exactly five commands, in order:** `npm run typecheck`,
   `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`. **There is no lint
   step and no format step in cezar.** Do not invent `npm run lint`.
3. **`packages/contract` has no `test` script.** Contract-only acceptance is `npm run typecheck`.
4. **Do not run `npm run test:e2e`.** One instance, one port, one lockfile. W5.1 owns it.
5. **Touch only the files your package owns.** If you need a route the scaffold did not
   create, stop and hand back to the orchestrator: a new route means `server.ts` plus
   `BACKWARD_COMPATIBILITY.md` section 2 plus `typed-bodies.test.ts`, which are scaffold-owned.
6. **cezar is a released npm package.** The workspace rule in `/Users/mw/loki-labs/AGENTS.md`
   ("pre-launch, no backward-compatibility burden") **does not apply inside `cezar/`**. This is
   a live contradiction between two AGENTS.md files; inside this repo, backward compatibility wins.
7. **Every new `CEZ_*` env var updates `.env.example` in the same commit.** `AGENTS.md` states
   it as law: "an undocumented env var is a bug." Deferring it to a later docs package
   guarantees at least one commit that violates a repo rule.
8. **Any new file under `.ai/cezar/` that holds run state must be added to `ensureDataGitignore`'s
   `wanted` list in the same PR.** Knowledge documents are the deliberate exception: they are
   content, they are committable, and they must stay out of that list.
9. **Register routes by chaining into a family builder, and never annotate the return type.**
   A loose `app.get(...)` and an annotated return type both drop the route from `AppType`
   silently while the server keeps serving it. That is exactly what `typed-bodies.test.ts` exists
   to catch, and it is how PR #694 shipped eleven unreachable routes.
10. **No new runtime dependency** (D7). **No clock-derived field in a GET body** (D8).
11. **Report back at most:** package id, files created, gate result, and one line on anything
    you could not do. Never paste the diff.
12. **Dispatch the implementation packages on Sonnet 5**, per the workspace rule in
    `/Users/mw/loki-labs/AGENTS.md` ("Delegating implementation, subagents run Sonnet 5"): use the
    `spec-implementer` agent, or `agent(prompt, { model: 'sonnet' })` in a Workflow script. Every
    package in the tables above is construction work against a settled contract, which is the test
    that rule sets. **The SOLO packages are the exception and stay on the session model**: W0.1
    (spec authorship), W1.1 (the scaffold, which decides the shape every other package builds
    against), W3.1 (activation), and W5.2 (release judgement). Nothing enforces this automatically,
    so a subagent dispatched without a `model:` silently inherits the session model and the choice
    never happens.

---

## Verification that the plan itself is honest

Three checks, each of which has failed in this workspace before and would fail silently again:

- **Negative control on search.** With identifier pinning disabled, the `SPEC-282` case must
  **fail**. A test that passes both ways proves the pin is decorative.
- **Pagination control on the Notion reader.** A two-page fixture whose only matching row sits
  on page 2 must return both pages, and a single-page read must report `complete: false`. This
  is the recorded false-empty bug (~45 consecutive loop ticks reporting "nothing to do" while a
  row sat on page 2) made unreachable by construction.
- **Flag-off byte identity.** With every flag unset, `/api/v1/health` and the agent system
  prompt must be **byte-identical** to the pre-change build. Anything less is not opt-in.

---

## Known open questions for the owner

1. **WhatsApp** (D12): ship it at all, given that unsolicited outbound needs an approved
   template and a session window? Recommendation: skip for now, iMessage plus Telegram covers it.
2. **Shared-instance auth.** Phase 3 multi-player needs a real auth model. cezar today has a
   loopback Host/Origin guard, a per-repo `launch-key`, and no bearer token, user identity,
   per-project ACL or rate limit. Two humans on one board with no login means an assignee is a
   free string anyone who can reach the port may set. This is the sharpest hole in the whole
   plan and it is an owner decision, not a default.
3. **`LICENSE`**: all five `package.json` files say `"license": "MIT"` but **there is no LICENSE
   file in the repo**, and no CONTRIBUTING, PR template, or CLA. Worth resolving with the
   maintainer before a large inbound PR, since it decides what inbound contribution even means.
4. **Phase 3 hosting.** If the ops board is fork-private anyway, is a separate small tool a
   better home than a fork of a published npm package? Recorded as a real alternative that was
   never evaluated, not as a recommendation to change course.
