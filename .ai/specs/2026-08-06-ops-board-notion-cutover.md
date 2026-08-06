# Ops board and Notion cutover (fork-private)

> **Feature F5, phase 3** of `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`. Work packages P3.1 to P3.7.
> Depends on: `2026-08-06-external-source-connectors-notion.md` (the Notion HTTP client and block-to-Markdown converter this reuses), `2026-08-06-knowledge-base-mounts-search.md` (the mount that renders the split Knowledge corpus).
> **Status: proposed, blocked on two preconditions.** Not started. Nothing in P3.1 may begin before both of them land.

## TLDR

This is **phase 3**, the last phase and the only fork-private one. It is the phase that actually removes Notion as the source of truth, and it carries every unresolved risk in the programme, so it is written to be the most cautious of the six specs: every flip is per surface, every flip has a named authoritative side and a named rollback, and the whole thing is gated on a reconciler that has to be provable red before its green is worth anything.

**It does not start until two preconditions land, and one of them is not an engineering task.**

1. **W1.9, the `report_issue` D1 dual-write, with seven consecutive days of exact Notion-and-D1 agreement.** That is a phase-1 wave-1 package with the longest lead time in the plan (PLAN.md, wave 1 note under W1.9). It gates the cutover because `report_issue` is the one path in this programme with real users, and its failure shape is silent.
2. **An owner decision on the auth model for a shared instance.** This one is a **decision, not a task.** No default in this spec can substitute for it, and none is offered. cezar today has a loopback host guard and a per-repo launch key and nothing else: no bearer token, no user identity, no per-project ACL, no rate limit, no CORS design. "Two humans on one board" with that stack means `assignee` is a free string that anyone who can reach the port may set. Until the owner answers, this phase ships **single-instance, loopback-only**, and the multi-human half of it is not built. See Open Questions, item 1.

What it delivers when those land: a `ticket` entity in a private git repo, a cross-machine lease built out of `git push` (which is a compare-and-swap on the remote ref, so a lease that either fast-forwards or is rejected is real mutual exclusion at about one second and zero new infrastructure), a per-surface migration with a phase 0 export taken before anything else, a reconciler with red controls and a behavioural replay seeded with two known historical bugs, and the six hard-won rules from the `notion-sync` skill rebuilt as mechanisms rather than remembered as prose.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why |
|---|----------|-----------------|-----|
| Q1 | Where does the board live? | A separate private git repo (`loki-labs/ops`) with its own remote, registered under an additive optional `ops` key in `~/.cezar/config.json`. Never under `<repo>/.ai/cezar/`. | `ensureDataGitignore` (`packages/cezar/src/index.ts:664-683`) writes `runs.json`, `todos.json`, `launch-key` and the automation files into `.ai/cezar/.gitignore`, and `BACKWARD_COMPATIBILITY.md:83` makes adding new run-data files to that list a documented contract. A gitignored board is not a board. Living in its own repo puts the ops store structurally out of reach of that function instead of relying on nobody adding it by reflex. |
| Q2 | Default on or off? | Off. The exact string `CEZ_OPS=1` opts in (D4). Unset means the domain is inert: every GET answers `200` with an empty payload, every mutator answers `409`, **never a `404` on any route in the family** (D19), no network, no credential, no timer. | The house spelling, stated at `AGENTS.md` "Zero config" and implemented at `packages/cezar/src/handoff.ts:127-129`. The inert shape is the follow-up-inbox precedent, asserted at `packages/cezar/src/server/inbox-gate.test.ts:11-19`: off, the reader degrades to empty (never a 404, the feature is switched off, not missing) and the mutators 409 as defense in depth. D19 settles it for all five flag-gated families, and a 404 is the wrong claim besides: it tells a client the route does not exist, which breaks the typed client's own contract. |
| Q3 | Is a ticket a run? | **No.** `ticket` is a new durable entity (D13). See Data Models for the full argument. | `RunRecord.task` is `z.string()` at `packages/contract/src/runs.ts:141` and is the run's prompt (the create input bounds it at 100,000 characters, `runs.ts:484`). `todos.json` is a delete-on-check list with an in-process lock (`packages/cezar/src/todos.ts:39-56`) that is gitignored by contract (`packages/cezar/src/index.ts:671`). Neither models a row that exists before it runs and after it finishes. |
| Q4 | Where does PII live? | **Never in a committed cezar directory** (D9). Handles, chat ids and agent ids are replaced by an opaque `reporterRef` at the import boundary; the resolution table lives in the chat-side D1 `reports` table from W1.9, which is not a git repo. A PII-shaped string reaching a write into the ops repo is a **hard write failure**, not a scrub and not a warning. | A phone number pushed to a git remote is unredactable and permanent: rewriting history does not recall a clone, and the ops repo exists precisely to be cloned onto a second machine. A scrubber is worse than a refusal here, because ticket bodies are byte-preserved and a silent edit destroys the reconciler's digest without telling anyone. The critic found no design in the programme had a PII rule at all; this is that rule. |
| Q5 | How is a ticket claimed across machines? | A lease whose acquisition is a commit plus a `git push` to the ops remote. Accepted push means you own it; rejected push means someone else does. | `git push` refuses a non-fast-forward, so the remote ref is a compare-and-swap on a 20-byte value with a real serializing authority. Approximately one second, no server, no new dependency, works from any machine that can already reach the remote. Every other primitive in the repo is process-local (see Problem Statement, axis B). |
| Q6 | What happens offline? | Degrade to a local advisory lease stamped `offline: true`, emit exactly one warning, never throw. The first push after reconnect either fast-forwards (the claim was uncontended and is retroactively valid) or is rejected, in which case the run's work is preserved on its branch and the ticket is flagged for a human. | `AGENTS.md` "Zero config": "degrade to a smaller working cockpit, never fail the boot." The degradation is loud because a silent local-only lease is indistinguishable from a real one, which is the failure this whole mechanism exists to remove. |
| Q7 | New runtime dependencies? | **None** (D7). ULID minting is ~40 lines of Crockford base32 over `randomBytes` from `node:crypto`. | The budget is exhaustively hono, @hono/node-server, yaml, zod, smol-toml, ws (`CODE_REVIEW.md`, "Code quality"). `randomUUID` is already the in-tree id source (`packages/cezar/src/runs/store.ts:2` and `:495`) but is not monotonic, and a board sorted by mint order without an allocator is the whole point of ULID. |
| Q8 | Does anything get deleted from Notion? | **No, ever.** Notion is demoted per surface, never emptied. Tombstones exist on the ops side; nothing is issued against Notion. | That MCP surface has no delete tool, so an accidental duplicate is permanent. A migration that cannot delete must not depend on deleting, and demote-not-delete also means every rollback has a live target to roll back to. |
| Q9 | Clock-derived fields in a GET body? | **Forbidden (D8), and D20 binds the lease itself with no exception.** A lease is served as `{state, acquiredAt, expiresAt, heartbeatAt, holder, fencingToken}` and never as `expiresInSeconds` or `age`. `state` is a **persisted enum written by a transition**, never a read-time comparison of `expiresAt` against a clock, and `GET /api/v1/ops/leases` may not filter its row set by a clock either. | `packages/cezar/src/server/route-parity.test.ts:13-24` issues the same GET under three spellings and asserts byte-identical bodies. A value that straddles a threshold between two of those reads is a flaky red gate that gets debugged as alias drift for a day. An earlier draft of this row derived `state` inside the store and called the result stored; naming it stored does not make it stored. Under that draft both `GET /ops/tickets/:ticketId` and an "active leases" listing return different bodies for two identical requests as a TTL crosses, which is the exact failure this row forbids everywhere else. D20 closed it: the expiry reclaim is the transition that writes the enum, and the listing is unfiltered. |
| Q10 | Who is authoritative during the migration? | Exactly one side per surface at a time, named per phase, with the reverse direction implemented and tested from the first mirror commit so every rollback is a config flip rather than a code change. | "Both sides authoritative" is not a migration strategy, it is two boards. Building the reverse direction only when it is needed means writing it during an incident. |
| Q11 | Does any of this go upstream? | **No** (D2). The entire feature is fork-private and the upstream blast radius is fixed at six lines and two documentation blocks, enumerated in Architecture. A test asserts the containment in both directions. | `open-mercato/cezar` is a general-purpose orchestrator and is never going to take a Loki ticket importer, an iMessage reporter notifier, or a Notion database id. Mixing them is what makes a fork unmergeable forever. Bounding the blast radius up front is what keeps `git merge upstream/main` a one-minute job. |
| Q12 | Auth for a shared instance? | **Not defaulted.** This is the one question the spec refuses to answer autonomously. Phase 3 ships single-instance and loopback-only; the shared-instance surface is not built until the owner decides. | A default here would be a security posture chosen by an agent for a board holding another person's data. Every other row in this table is a reversible engineering choice; this one is not. See Open Questions, item 1. |

## Problem Statement

"Single player" is not one condition. It is three, they fail for different reasons, and cezar already solves exactly one of them.

### Axis A: two humans

The pipeline is single-identity, and it is the pipeline rather than Notion that makes it so. Every agent write is attributed to one person. On the Notion side the `Person` property is used by **0 of 435 task rows**, so ownership is overloaded onto a status value: `Status = In Progress` is asked to mean "someone is on this", and a status cannot distinguish "Marcin is on it" from "an agent is on it" from "an agent died holding it three hours ago". A second human writing into the same board has no field that says the row is theirs and no way to see that a row is already claimed.

Rule 3a of the workspace doctrine (a correction must mark what it invalidates, in place) compounds this: it is a read-modify-write over one 783 KB Notion page with no locking. Two sessions correcting two different entries in the same minute is a last-writer-wins overwrite of a document every session reads first.

### Axis B: two machines

This is the documented hard fail, and cezar is worse at it than the workspace it would replace.

- `WorkspaceSemaphore` is an **in-process counter**. It holds `private readonly participants = new Set<SemaphoreParticipant>()` (`packages/cezar/src/workspace/semaphore.ts:149`) and `busy()` (`semaphore.ts:172`) sums the slots held by managers registered in **this process**. Its own header says it is "ONE shared object across every `RunManager`" threaded through `ProjectContexts` and the boot manager (`semaphore.ts:8-12`), which is exactly one process. A second machine is invisible to it.
- The todos lock is an **in-process promise chain**: `const locks = new Map<string, Promise<unknown>>()` at `packages/cezar/src/todos.ts:41`, and `withLock` (`todos.ts:43-56`) chains onto the previous promise for the same key. The file header says so plainly (`todos.ts:11-13`: "Server writes are serialized with an in-process lock"). Two cezar processes on two machines writing the same file serialize with nothing.
- The **only cross-process primitive in the repo** is `AutomationStore.acquireLease` (`packages/cezar/src/automations/store.ts:208-225`): a pid-keyed `O_EXCL` create (`openSync(path, 'wx', 0o600)`, `store.ts:212`) with a **10-minute mtime reclaim** (`staleAfterMs = 10 * 60_000`, `store.ts:208`; `statSync(path).mtimeMs`, `store.ts:217`) and **no fencing token**. It writes `{pid, startedAt}` into the lock file (`store.ts:213`), but nothing ever reads it: the reclaim decision comes from the file's mtime alone, so the payload identifies no machine and expresses no expiry. The reclaim itself is an `unlinkSync` inside a `catch` that swallows (`store.ts:218-223`), so it is **silent**. And `O_EXCL` on a local path is not a lock between machines at all.

So on axis B there is nothing. Not a weak mechanism, nothing.

### Axis C: many concurrent agents, on one box

**cezar already solves this, and this spec must not re-solve it.** Each run gets its own git worktree, project contexts are built lazily per project (`packages/cezar/src/server/project-context.ts:16` and `:218-232`), the workspace semaphore caps parallelism across every registered manager, and per-item receipts make work idempotent. What breaks at scale is not the runtime but the **board**: fan-out collides at file level rather than topic level, and a dispatched row has no lease, so a dead agent leaves a row reading `In Progress` forever with no holder, no expiry and nobody to notice.

### And cezar has no board to put any of this on

`RunRecord.task` (`packages/contract/src/runs.ts:141`) is the run's prompt, bounded at 100,000 characters on create (`runs.ts:484`) and patchable while the run has not started (`runs.ts:548-551`). `/api/v1/runs/:id` is the run thread. `todos.json` is a flat delete-on-check inbox, gitignored by contract (`packages/cezar/src/index.ts:671`), off by default (`packages/cezar/src/handoff.ts:127-129`), and its whole semantic is "remove the entry when it is handled". Neither is a backlog row.

## Research

**`git push` is a compare-and-swap.** A push is accepted only when the ref being updated is an ancestor of the commit being pushed; otherwise the remote rejects it as non-fast-forward. That is precisely compare-and-swap on the ref value, evaluated by a single serializing authority (the remote), across every machine that can reach it. It costs one network round trip (approximately one second), it fails closed when offline, and it requires no new infrastructure, no daemon, no port and no database. This is the strongest idea in the design and everything about the lease is built on it.

**cezar's four route drift guards.** A new route family that lands half-finished compiles on its own branch and stops working when it merges. `bc-route-inventory.test.ts:9-30` reads the registered routes off a **built app** and compares them against the `BACKWARD_COMPATIBILITY.md` section 2 prose inventory (expanding its brace-compressed groups first), so an undocumented route is a red test. `route-parity.test.ts:13-24` asserts the three spellings of a project-scoped route answer byte-identically. `contract-parity*.test.ts` asserts both directions between the zod schema and the inferred response type (`AGENTS.md`, "The HTTP API": a one-way check passes on real drift). `typed-bodies.test.ts` catches a loose `app.get(...)` that vanishes from `AppType`, which is how PR #694 shipped eleven unreachable routes.

**Route registration is a chained family.** `server.ts:5083-5100` builds `v1` as one chained expression, with the comment that it is "written as ONE chained expression because that is the only shape Hono can infer route types from". `server.ts:5104-5114` builds `workspaceV1` the same way for families that answer for the whole workspace and are therefore single-mount ("never a project-scoped spelling, which would be a second surface to protect with no consumer"). The ops board spans six products across four repos, so it belongs on `workspaceV1`.

**Git hardening already exists in-tree.** `packages/cezar/src/skills-remote.ts:43-54` sets `protocol.ext.allow=never`, `protocol.fd.allow=never`, `protocol.file.allow=user`, `GIT_ALLOW_PROTOCOL` and `GIT_TERMINAL_PROMPT=0`, with the reasoning recorded above it (`skills-remote.ts:35-42`): `ext::` is the arbitrary-command-execution vector and a credential prompt must never hang the boot. The ops git transport reuses this verbatim. Note the honest difference: that code does read-only bare clones, and this one pushes.

**The Notion surface has two read paths with opposite blind spots.** `query_database_view` returns rows newest-first and must be paged until `has_more` is false; SQL through `notion-query-data-sources` answers the whole board in one call but can lag about an hour on brand-new rows. The recorded rule is view for recent, SQL for the whole board, believe the view when they disagree (`chat/.claude/skills/notion-sync/SKILL.md:106-119`). Two recon passes of this workspace disagreed on the census (435 versus 431 tasks, 608 versus 609 changelog rows), which is that same lag showing up inside the recon itself. Any census quoted from prose is therefore already wrong.

**Two historical bugs are the replay's seed data.** The page-2 false empty: a "no `Todo` rows" conclusion drawn from page 1 was reported for approximately 45 consecutive loop ticks on 2026-08-05 while a `Todo` row sat on page 2 (`chat/.claude/skills/notion-sync/SKILL.md:106-110`). The stale project filter: the dispatch step filtered `Project = Loki`, written when every row was tagged `Loki`, and the tagging convention changed on 2026-07-14 to one tag per product while the filter did not (`chat/.claude/skills/notion-sync/SKILL.md:199-203`).

**The gate is five commands and there is no linter.** `package.json:16-41` defines `typecheck` (with `pretypecheck` running `build:server`), `test`, `test:unit`, `build`, `test:package`, `test:e2e`. There is **no `lint` script and no `format` script.** `test:e2e` is `sh .ai/scripts/e2e.sh` and reports `TEST_E2E_STATUS=passed|skipped|failed` (`.ai/scripts/e2e.sh:6-12`); `skipped` is not a pass. `SDLC.md:69-71` makes `needs-qa` without `qa-approved` a hard merge block regardless of every green check.

**The workspace repo has no remote.** `git remote -v` at `/Users/mw/loki-labs` returns nothing. The cezar fork has `origin` (`MarcinWalendowski/cezar`) and `upstream` (`open-mercato/cezar`). So the ops repo is genuinely a new remote, not a reuse of an existing one, and its credential is a new question (Open Questions, item 3).

## Proposed Solution

Two planes, split on what each is genuinely good at.

**Files are the record.** One git repo, one file per entity, plain Markdown and NDJSON. It survives a dead server, it merges, it is hand-editable, it is greppable, and deleting the derived index rebuilds it. This is the durability substrate.

**The remote ref is the referee.** The honest limit of a file-on-disk model is that files cannot answer "who owns this row right now": every such question needs a serializing authority and a laptop has none. `git push` supplies one that already exists. The lease is a commit that either fast-forwards or is rejected.

**A shared cezar instance, if the owner authorizes one, is the coordination plane and nothing else.** It is authoritative for nothing durable: every lease it grants is also a commit, every ticket it serves is a file. Losing it costs liveness and the ingest endpoint, never durability, and the fallback is exactly today's single-player mode. Until the owner answers the auth question, it is not built.

**The migration is per surface with one authoritative side each**, ordered easiest-to-hardest, with a phase 0 export taken first and a reconciler that must be provably red before its green is believed.

## Architecture

### Fork containment (D2): where it lives and how it stays separable

Everything new lives in five places, four of which are new directories nothing upstream touches:

| Path | New? | Contains |
|---|---|---|
| `packages/cezar/src/ops/` | new dir | store, ids, index cache, git transport, lease, notion importers, reconciler, mirror, CLI, notify |
| `packages/contract/src/ops.ts` | new file | every ops request and response as a zod schema |
| `packages/cezar/src/server/ops-routes.ts` | new file | the whole `/api/v1/ops/*` family, one chained builder |
| `packages/web/src/routes/ops/` | new dir | board, ticket detail, comment composer |
| `loki-labs/ops` | new repo | the board itself, outside cezar entirely |

The **upstream blast radius is six lines and two documentation blocks**, and that is the whole of it:

1. `packages/contract/src/index.ts`: one `export * from './ops.ts';` appended (the file is 16 lines today).
2. `packages/cezar/src/server/server.ts`: one `.route('/', opsRoutes)` inside the `workspaceV1` chain (`server.ts:5104-5114`).
3. `packages/cezar/src/server/capabilities.ts`: one `ops:` key in the `resolveCapabilities` return literal (`capabilities.ts:130-140`), which also requires one key in `packages/contract/src/health.ts` or `contract-parity.test.ts` fails on the `Exact<>` assertion.
4. `packages/web/src/components/nav-items.ts`: one nav entry gated on that capability.
5. `packages/web/src/routes.tsx`: one lazy route.
6. `.env.example`: one `CEZ_OPS=1` block, in the same commit as the flag (`AGENTS.md`: "an undocumented env var is a bug").

Plus `BACKWARD_COMPATIBILITY.md` section 2 gets **one contiguous block** headed "Ops board (fork-private, `CEZ_OPS=1`)". `CHANGELOG.md` also gets one entry, but **this phase does not write it**: the plan gives that file to W5.2, so no package here touches it. The BC entry is not optional: `bc-route-inventory.test.ts:9-30` reads routes off the built app and fails on any route the prose does not list. Keeping it as one contiguous block is what keeps the merge conflict surface to a single hunk.

Two containment tests, both directions, because a one-way check passes on real drift:

- **No import from `src/ops/` appears anywhere outside `src/ops/`, `ops-routes.ts` and the ops web routes.**
- **No file under `src/ops/` imports from another feature domain**, only from `src/paths.ts`, `src/workspace/config.ts`, the contract, and node builtins.
- **No Loki string in upstreamable code**: a grep for the Notion database ids, `lokimessages`, `beside`, `predicts` and `imsg` over `packages/cezar/src` **excluding** `src/ops/` must return zero hits.

### The PII rule (D9)

Report bodies carry phone numbers (`Handle: +48…`), chat ids and agent ids. The ops repo has a remote, and a clone is not recallable.

- **The ops repo stores a reference, never an identity.** A ticket's reporter is `{ref, transport, kind, subject}` where `ref = "rpt_" + hmacSha256(key, agentId + ":" + chatId).slice(0, 16)`. The HMAC key lives at `~/.cezar/ops-reporter.key` (mode `0600`, generated on first use, never committed, covered by `assertCezarHomeWriteIsSandboxed` at `packages/cezar/src/paths.ts:36`).
- **The resolution table lives on the chat side**, in the D1 `reports` table that W1.9 creates. `cez ops notify` sends refs; the chat worker resolves them locally and never returns a handle over the wire.
- **A write guard runs on every byte entering the ops repo.** `assertNoPii(text)` rejects E.164-shaped numbers, email addresses, and the `agt_` / `chat_` id prefixes. A hit is a **hard failure** naming the entity and the byte offset, not a scrub: ticket bodies are byte-preserved and a silent edit would destroy the reconciler's digest without telling anyone, and "the tool quietly fixed it" is how a rule stops being enforced.
- **Redaction happens at the import boundary**, not at render time, so the raw value never touches the working tree even transiently.
- **The remote is opt-in and starts absent.** With no `ops.remote` configured the store is local-only. The PII guard runs regardless of whether a remote is configured, because the failure this prevents is a commit, not a push.

### The lease: push as compare-and-swap

`leases/<ticketId>.json`, committed on `main` of the ops repo. Acquisition is: fetch, fast-forward, verify the lease file is absent or expired, write it, commit, push. **An accepted push is the grant. A rejected push is the refusal**, and the loser reads the winner's holder record from the fetch that follows.

The four properties the mkdir lock lacked, each mapped to a recorded failure:

| Property | The lease | What `automations/store.ts` has | The failure it maps to |
|---|---|---|---|
| **TTL** | `expiresAt`, a stored field on the record, 10 minutes past the last heartbeat, alongside a stored `state` that only a transition moves off `held` (D20) | Staleness derived from file mtime at reclaim time (`store.ts:217`), never expressed on the record | A 2026-08-04 lock held for three hours with no process alive. Nothing on disk said when it should have died. |
| **Holder record** | `{holder, machine, pid, runId, acquiredAt}`, written and **read** by every contender | `{pid, startedAt}` is written (`store.ts:213`) and never read; the reclaim uses mtime alone, and it names no machine | The `owner.txt` the skill snippet forgot to write. A contender that cannot say who holds the lock cannot report it, so a wedge looks like a hang. |
| **Heartbeat** | `heartbeatAt` rewritten every 3 minutes; 3 missed beats means expired | None. mtime is only updated by a create | A live-but-slow holder is indistinguishable from a dead one without a beat. |
| **Fencing token** | Monotonic `fencingToken` per ticket, carried on every write the holder makes; a write whose token is below the ticket's `leaseEpoch` is rejected | None | A resurrected zombie that slept through its own expiry writes over the new holder's work. |

**The expiry reclaim is loud, and that is load-bearing.** A silent reclaim is the orphaned-lock bug returning wearing a different hat: the system recovers, nobody learns that a holder died, and the same crash recurs undiagnosed. A reclaim therefore does three things in one commit: writes a `lease-reclaimed` changelog line naming the previous holder, machine, `runId` and the age at reclaim; emits a `lease-reclaimed` workspace event; and returns the reclaim in the acquire response so the caller reports it rather than proceeding as if it had won cleanly. Its negative control is in Verification: suppress the notice and the test must fail.

**The reclaim is also the transition that writes `state` (D20), and it is the only thing that expires a lease.** `state` is persisted on the record as `held` | `expired` | `released`, written by exactly three transitions: acquire writes `held`, release writes `released`, and the reclaim writes `expired` in the same commit that emits the notice above. It is never recomputed from `expiresAt` at read time, so a read never mutates and two identical reads can never disagree. The reclaim is triggered by an acquire attempt on that ticket, by the holder's own missed heartbeat, by `cez ops gc`, and by the store's boot and `fs.watch` sweep, never by somebody reading the board. The honest consequence is that a lease whose `expiresAt` has passed and which no transition has yet reclaimed still reads `state: held` with an `expiresAt` in the past. That is the correct answer and it is visible: the pair of fields says "nobody has reclaimed this yet", the sweep will, and the reclaim will say so out loud. The alternative, a read that silently expires the row, is what makes the lease listing flaky and the reclaim quiet, which are the two bugs this section exists to prevent.

**Cost arithmetic, stated because it is a real cost.** A heartbeat is one commit and one push touching one file. At a 3-minute beat that is 20 commits per hour per active lease, about 480 per day if one lease is continuously held. That is why `cez ops gc` exists: it squashes `leases/` history and prunes released lease files. A 10-minute TTL (matching the existing automation staleness window, `store.ts:208`) rather than a 60-second one is a deliberate trade: the cost of a long TTL is bounded waiting, and the cost of a short TTL is heartbeat noise plus false reclaims of a holder on a slow link.

### The store

Per-entity read and write over the ops repo: atomic tmp plus rename, mode `0600` on files and `0700` on directories, per-entry `safeParse` salvage (a malformed ticket is skipped with one warning and every other ticket still reads, never fatal), a sha256 content `version` for optimistic concurrency on document PUTs, tombstones instead of deletes, ULID minting, and a derived `.index/` rebuilt on boot and on `fs.watch`. Deleting `.index/` and reading again returns identical results, which keeps `AGENTS.md`'s "no database, delete it and it rebuilds" literally true.

The store is **workspace-level, not per-project**, deliberately departing from the `ProjectContext` pattern (`packages/cezar/src/server/project-context.ts:16`, `:218-232`). One board spans six products across four repos; sharding it per project would turn the un-delegatable central dedupe pass into a cross-repo fan-out, which is the exact construction that produces one row per item. The precedent for a workspace-level single-mount family is already in `server.ts:5104-5114`.

### Flag-off behaviour

With `CEZ_OPS` unset: routes exist and are typed, GETs answer `200` with empty collections, mutators answer `409`, **no handler in the family ever answers `404`** (Q2, D19: the feature is switched off, not missing), the nav item is hidden, no git process is spawned, no credential is read, no timer is armed, and `GET /api/v1/health` is byte-identical to the pre-change build. This is the `inbox-gate.test.ts:11-19` shape, and byte identity of health is the plan's own honesty check (PLAN.md, "Verification that the plan itself is honest").

## Data Models

### Why `ticket` is a new entity (D13)

`RunRecord` is the run's prompt and lifecycle. Its `task` field (`packages/contract/src/runs.ts:141`) holds the text handed to the agent; the create input caps it at 100,000 characters (`runs.ts:484`) and `patchRunInputSchema` (`runs.ts:548-551`) lets it be edited only until the run starts. A record comes into existence when work begins and its terminal states are `done`, `failed` and `cancelled`. A backlog row exists **before** anything runs, survives many runs, and outlives all of them.

`todos.json` is the opposite failure. It is a flat array agents append to, it is read through an in-process lock (`packages/cezar/src/todos.ts:39-56`), it is off unless `CEZ_FOLLOWUPS=1` (`handoff.ts:127-129`), it is **gitignored by contract** (`packages/cezar/src/index.ts:671`, and `BACKWARD_COMPATIBILITY.md:83` makes that list a documented surface), and its semantic is delete-on-check. A board whose rows disappear when handled has no history, and a board that is gitignored cannot be shared with a second machine or a second human, which is the entire point of this phase.

So: a third entity. Overloading either is how the board and the executor become the same broken thing.

### Repository layout

```
ops/
  ops.json                      # {schemaVersion, projects[], members[]}
  tickets/<id>.md               # YAML front matter + Markdown body
  tickets/<id>.comments.ndjson  # append-only, concat-merges
  by-notion-id/<notionId>       # symlink to ../tickets/<id>.md; O_EXCL create = dedupe by write constraint
  capture/<id>.md               # memos and reports, body never edited
  knowledge/<slug>.md           # one file per H2 entry (was one 783 KB page)
  knowledge/INDEX.md            # derived, regenerated, never hand-edited
  changelog/<YYYY-MM>.ndjson    # append-only, monthly to bound conflict scope
  leases/<ticketId>.json        # the CAS lease
  export/                       # phase 0 snapshots, immutable
  .index/                       # derived cache only; delete it and it rebuilds
```

One file per entity is what survives concurrent writes: two edits to two different tickets merge cleanly, and a conflict happens only when the same entity is edited twice. A single JSON array conflicts on **every** concurrent write.

### Ticket front matter

YAML, because the format has to survive hand-editing and 429 chat specs with 25 status spellings are the evidence that a bold-bullet prose block does not.

| ops field | type | from Notion | note |
|---|---|---|---|
| `id` | `tkt_<ULID>` | page id | monotonic and collision-free with no allocator, which is the answer to the cross-machine number race |
| `title` | string | `Task` | |
| `status` | `todo` \| `in_progress` \| `blocked` \| `qa_needed` \| `done` | `Status` | snake_case on the wire, labels in the UI |
| `project` | slug | `Project` | open registry in `ops.json`, not a closed union: adds the repos Notion never had a project for |
| `priority` | `low` \| `medium` \| `high`, optional | `Priority` | 38 of 435 rows have none |
| `origin` | `voice` \| `user_report` \| `capture` \| `log_watch` \| `manual` | `Origin` | widened: `Voice` asserts something untrue for a typed memo, and log-watch is a fourth writer with no representable origin today |
| `assignee` | string or null | `Person` (0 of 435 used) | the field that stops ownership being overloaded onto `Status`. **Free-string until Q12 is answered**, and that is exactly the hole. |
| `createdAt` / `updatedAt` | ISO-8601 Z | `Created` | |
| `notionId` / `notionUrl` | string, optional | page id and url | migration provenance key: present on every imported entity, absent on every native one. Makes reconciliation possible and double import impossible |
| `sourceRef` | `{kind: 'capture'\|'report', id}`, optional | link-back in body | |
| `reporter` | `{ref, transport, kind, subject, dedupeKey}`, optional | the Reporter block in the body prose | lifted out of prose into fields, and **redacted**: `ref` is the HMAC, never the handle. This is what stops the notifier parsing Markdown a human wrote |
| `spec` | `{repo, path, number?}`, optional | prose | |
| `touches` | `string[]`, optional | none | declared file globs; the dispatcher queues rather than grants a second lease whose globs intersect an active one |
| `lease` | see below | none | nothing in Notion has this |
| `revision` | int | none | optimistic concurrency, the automations precedent |
| `tombstone` | bool | none | Notion has no delete; neither do we, deliberately |

The body below the front matter is **byte-preserved Markdown**: `## Context`, `## What to do`, `## Acceptance criteria`, plus appended `## Implemented <date>` and `## Shipped <date>` sections. Byte preservation is what makes the reconciler's digest meaningful.

### Comments

`tickets/<id>.comments.ndjson`, one object per line: `{seq, id, author, ts, body, resolved, replyTo?, attachments: [{name, unreadable: true}]}`. Append-only is what makes two writers safe under git, because both-sides-added hunks concatenate rather than conflict; `seq` renumbers on read.

This is the single largest capability **upgrade** in the migration. Notion has no workspace-wide comment query, so sweeping the board means one `get_comments` call per row, 435 of them. A `grep -l` over `tickets/*.comments.ndjson` answers "which tickets have unread comments" in one pass.

### Lease record

```
{ ticketId, state, holder, machine, pid, runId,
  acquiredAt, heartbeatAt, expiresAt,
  fencingToken, reclaimedAt?, offline? }
```

`state` is a **persisted enum** (`held` | `expired` | `released`) written into the record by a transition and read back verbatim, never a comparison of `expiresAt` against any clock, and never a countdown (Q9, D20). Acquire writes `held`, release writes `released`, and the expiry reclaim writes `expired` together with `reclaimedAt` in the loud commit described under the lease. Consequently `GET /api/v1/ops/leases` lists lease records by their stored `state` and **never filters its row set by a clock**: a caller that wants only held rows filters on the stored enum, which is a deterministic predicate over bytes on disk rather than a row set that changes between two identical requests.

### Capture, changelog, knowledge

- `capture/<id>.md`: front matter `{id, kind: memo|report, status: raw|processed, capturedAt, source, project?, notionId?}` plus a verbatim body. **Content is never edited**, enforced by a test rather than a convention.
- `changelog/<YYYY-MM>.ndjson`: `{ts, type, area, title, body, ticketIds[], notionId?}`. Monthly files bound the conflict scope; the measured rate is roughly 540 rows per month.
- `knowledge/<slug>.md`: one file per H2 entry, with `supersedes` and `correctedOn` as structured front matter so rule 3a becomes checkable rather than merely required. The 783 KB page carries 21 "superseded" and 61 "corrected" markers today, all of them prose.

### Schema evolution

The ops store is neither config nor run state, so it needs its own answer. **Additive zod only** (every new field optional or `.catch()`), matching the house rules already applied at `packages/cezar/src/workspace/config.ts:42-52` (`.catch()` per key, `.passthrough()` at every object level). Plus an `ops.json` `schemaVersion` running through a copy of the `workspace/migrations.ts` framework scoped to **`ops.json` and the derived index only**. Ticket, comment, capture and knowledge files never migrate: they are the hand-editable corpus, and a migration that rewrites a human's Markdown is a data-loss bug with a nice name.

## API Contracts

Every shape is a zod schema in `packages/contract/src/ops.ts` with its type inferred (`AGENTS.md`, "The HTTP API"). The family is registered by **chaining into one builder with no annotated return type**, mounted once into `workspaceV1` (`server.ts:5104-5114`), never mirrored under `/p/:projectId`. Bodies, path params and query strings are validated as route middleware through `packages/cezar/src/server/validators.ts:88`, `:152` and `:160`, never inside a handler.

| Method and path | Purpose | Flag off |
|---|---|---|
| `GET /api/v1/ops/tickets` | list; query `status`, `project`, `assignee`, `cursor`, `limit` | `200 {tickets: [], cursor: null}` |
| `POST /api/v1/ops/tickets` | create | `409` |
| `GET /api/v1/ops/tickets/:ticketId` | detail with body and lease | `200 {ticket: null}` |
| `PATCH /api/v1/ops/tickets/:ticketId` | update; requires the caller's `version` sha256 | `409` |
| `GET /api/v1/ops/tickets/:ticketId/comments` | thread | `200 {comments: []}` |
| `POST /api/v1/ops/tickets/:ticketId/comments` | append | `409` |
| `POST /api/v1/ops/tickets/:ticketId/lease` | acquire; answers `{granted, holder, reclaimed?}` | `409` |
| `POST /api/v1/ops/tickets/:ticketId/lease/heartbeat` | extend | `409` |
| `DELETE /api/v1/ops/tickets/:ticketId/lease` | release, idempotent | `409` |
| `GET /api/v1/ops/leases` | every lease record with its holder and its stored `state`; the row set is never filtered by a clock (D20), and an optional `state` query filters on the stored enum | `200 {leases: []}` |
| `GET /api/v1/ops/capture` | capture inbox | `200 {items: []}` |
| `GET /api/v1/ops/changelog` | changelog window | `200 {entries: []}` |
| `GET /api/v1/ops/reconcile` | the last stored report | `200 {report: null}` |
| `POST /api/v1/ops/reconcile` | run one now | `409` |
| `GET /api/v1/ops/mirror` | per-surface authority map | `200 {surfaces: []}` |
| `PUT /api/v1/ops/mirror` | flip a surface's direction | `409` |
| `POST /api/v1/ops/sync` | pull then push | `409` |

Seventeen routes, all listed as one contiguous block in `BACKWARD_COMPATIBILITY.md` section 2, all landing in P3.1 as an inert scaffold before any implementation exists. Two contract rules that recur and are called out in `AGENTS.md`: spread a possibly-undefined key conditionally rather than typing it `key: maybeUndefined` (`JSON.stringify` drops it from the wire), and write literal discriminants `as const` or hono widens them to `string`.

The lease response carries `expiresAt` and `heartbeatAt` as stored ISO strings and `state` as the persisted enum a transition wrote, read back verbatim rather than recomputed. It carries no computed age, and the listing applies no clock-derived filter, per Q9 and D20.

## Migration: phased per surface, with an authoritative side and a rollback for each

No big bang. Six flips, easiest first, each with exactly one authoritative side.

### M0. Export, taken before anything else

The **backup**, and it comes first because the mirror is a derived cache: if the Notion source were ever pruned, a rebuildable cache is not a copy of anything. `export/` is immutable, and the census is captured **atomically inside the same enumeration that captures the rows** and written to `export/census.json`. Nothing downstream ever quotes a count from prose; the reconciler reads the census file. A count that cannot be reproduced from the export is a failed export, not a failed migration.

Rollback: none needed, it writes nothing outside `export/`. Exit criterion: re-running the export produces the same census, and every row in the census has a corresponding file.

### M1. Capture (Raw Input, Reports). Authoritative: **Notion**

ops mirrors read-only. Nothing in cezar can mutate Notion at this phase. Rollback: stop the poller; ops holds a stale mirror nobody reads.

### M2. Changelog. Authoritative: **ops**

The lowest-risk flip: append-only, no second writer, no reader depends on it being live. Notion becomes a write-through mirror. Rollback: flip the surface's direction in config (no code change) and replay the ops rows into Notion, which is safe because changelog rows are append-only and carry `notionId` when they came from Notion.

### M3. Tickets, read only. Authoritative: **Notion**

The ops board becomes usable for reading and dispatch while Notion still owns every write. This is where the lease starts being real: a ticket is claimed in ops even though its content comes from Notion. Rollback: stop the importer.

### M4. Tickets, writes. Authoritative: **ops**

Two exit criteria, both of which must hold before the flip:

1. The reconciler has reported `missing:0 extra:0 differing:0` on tickets for **seven consecutive days**.
2. **The second human has written through the cockpit composer at least once.** That use is the criterion, not a date. Until then, his only write path is a git push, and a flip that lands before the composer strands the only external contributor.

Notion becomes a write-through mirror: best-effort, never blocking an ops write (a Notion write can 402 on a plan limit and can lag an hour), and a failed mirror is reported as **drift, never retried into a duplicate**, because duplicates on that surface are permanent. Rollback: config flip, then replay from the ops side; the `notionId` provenance key makes the replay an update rather than an insert.

### M5. Comments. Authoritative: **ops**

Last of the live surfaces, ordered here deliberately: both live comment threads belong to the second human. Notion comments stay authoritative and are polled until M4's composer criterion has been met. Rollback: config flip; comments are append-only so a replay cannot lose one.

### M6. Knowledge. Authoritative: **ops**

The 783 KB page, one flat document, 271 H2 sections, growing roughly four times faster in August than July. It migrates last because it is the phase most likely to lose content silently and it is the surface every session reads first. The splitter is byte-exact and reversible: `cez ops knowledge join` reassembles the original page and the reconciler asserts it is **byte-identical to the M0 export** before the flip is allowed. Rollback: the join output is the original file.

**Notion is never deleted at any phase.** It is demoted to a mobile view and the second human's read path. There is no delete tool on that MCP surface, and demote-not-delete is also what leaves every rollback a live target.

## Reconciliation: a real check, not a vibe

Four levels, each strictly stronger than the last.

**1. Census.** Counts per surface, read from `export/census.json`, never from prose. A mismatch is a failed export.

**2. Canonical content digest, computed on both sides.** `normalize()` fixes line endings, trailing whitespace, front-matter key order and the Notion block-to-Markdown quirks, then sha256. The `normalize()` rules are **pinned by a fixture file**: changing them without updating the fixture fails the suite, so nobody can make a diff disappear by loosening the comparator.

**3. A three-list report with unified diffs.** `missing` (in Notion, absent from ops), `extra` (in ops, no such `notionId` in Notion), `differing` (both present, digests disagree), each `differing` entry carrying a unified diff of the normalized text. Running the reconciler twice must produce byte-identical output, because non-determinism shows up as `differing` noise and trains the reader to ignore the report.

**4. A behavioural replay.** Replays 30 days of history and asserts the ops board answers the same "which tickets are dispatchable" question the Notion board answered. Two conforming implementations are not an oracle, so the two sides are made to **fail differently by construction**: one reads the frozen M0 snapshot, the other re-fetches live, and a random 5% sample is cross-checked live every cycle, so an export bug and a read bug cannot cancel each other out.

### Red controls, because a green reconciler proves nothing until it can be made red

| Control | Mutation | Required output |
|---|---|---|
| GREEN | a clean import, run twice | `missing:0 extra:0 differing:0`, byte-identical across the two runs |
| RED 1 | delete exactly one ticket file | exactly `missing:1`, naming that `notionId` |
| RED 2 | change exactly one character in one ticket body | exactly `differing:1`, with a one-character unified diff |
| RED 3 | add a ticket carrying a `notionId` Notion never had | exactly `extra:1` |
| DIGEST PIN | change a `normalize()` rule without updating the fixture | the suite fails |

### The replay's seeded bugs

The replay is seeded with the **two known historical bugs as fixtures, and it must report divergence on both**:

1. **The page-2 false empty** (`chat/.claude/skills/notion-sync/SKILL.md:106-110`): a fixture where page 1 is full and the only `Todo` row sits on page 2. The Notion-side reader that stops at page 1 must diverge from the ops board.
2. **The stale project filter** (`chat/.claude/skills/notion-sync/SKILL.md:199-203`): a fixture where rows carry per-product tags and the query filters `Project = Loki`. Same requirement.

**A replay that reports agreement on those two is itself broken**, and the test asserts divergence rather than agreement. This is the one place where the expected result of a correctness check is "these two disagree".

## Preserved lessons from the notion-sync skill

Six rules were learned the hard way. Each is restated with the mechanism that makes it **unreachable** rather than merely remembered, because a rule that lives only in prose is one context window away from being violated.

1. **Exhaustive enumeration, never the first page.** (`chat/.claude/skills/notion-sync/SKILL.md:106-110`.) `enumerateAll` returns `{items, complete}` and there is **no API in the importer that returns a bare array**. A `complete: false` value passed to any consumer that asserts emptiness throws. You cannot read a partial page as a whole because the type does not let you hold one.

2. **A central dedupe pass before any fan-out.** (`SKILL.md:92-96`.) The importer and the note processor take the whole candidate set and emit a match map **before** any per-item work begins, and the API exposes no per-item create call at all. Without a central pass, N items become N new rows by construction even when two are one defect; with no per-item entry point, the construction is not available.

3. **A comment on a blocked row is usually the unblock.** (`SKILL.md:120-121`.) Comments are a file per ticket, so "which tickets have unread comments" is one `grep -l` over `tickets/*.comments.ndjson` instead of 435 `get_comments` calls. The sweep stops being expensive, and a sweep that is cheap is a sweep that actually runs before dispatch rather than after it.

4. **One message per conversation, not one ping per item.** (`SKILL.md:195-201`.) `cez ops notify` takes a **set** of shipped tickets, groups by `(agentId, chatId)` internally, and **exposes no single-report call**. The spammy shape is not a discouraged usage, it is an absent one.

5. **The dedupe key is the report id, never the ticket id.** (`SKILL.md:206-211`.) `reporter.dedupeKey` is populated from the source report id at import and is immutable thereafter; the ticket id is **not a field in the notify payload schema**, so it cannot be sent by mistake. Per-item receipts stay in the conversation Durable Object, untouched.

6. **Image attachments cannot be read, so a conclusion must say what it could not see.** (`/Users/mw/loki-labs/.claude/skills/notion-sync/SKILL.md:192-197`: `notion-download-attachment` fetches only text attachments this integration itself uploaded, and the comment payload carries no signed URL.) Imported attachments carry `unreadable: true`, the renderer shows an explicit "attachment could not be read" notice rather than omitting it, and a ticket carrying an unreadable attachment is flagged in the body. A conclusion that silently ignores the evidence attached to it is worse than one that names what it could not see.

## Phases

Mapped one to one onto PLAN.md's phase 3 package table. Sizes are the plan's. **Neither P3.1 nor anything after it starts before both preconditions in the TLDR have landed.**

### P3.1 Ops entity store: ULID ids, per-entity files, derived index, tombstones (L)

**One elaboration on the plan's title, stated because it changes the package's shape:** P3.1 also lands the **complete inert route surface** (contract domain, the chained family, middleware validation, the BC section 2 block, the `typed-bodies` rows, the contract-parity test, and every shared-file edit from the Architecture blast-radius table). cezar's four drift guards make a half-landed route family a red gate, and #694 shipped eleven unreachable routes for exactly this reason. Splitting the scaffold out would mean two packages editing `server.ts`.

**The chokepoint files are claimed here under an explicit grant, not in spite of the authority.** D6 gives every shared file to the one solo scaffold package, W1.1, and on the letter that would put `packages/contract/src/index.ts`, `packages/contract/src/health.ts`, `packages/cezar/src/server/server.ts`, `packages/cezar/src/server/capabilities.ts`, `packages/web/src/components/nav-items.ts`, `packages/web/src/routes.tsx` and `.env.example` out of reach here. **PLAN.md D22b grants them to this package by exception**, on the reasoning that phase 3 is temporally separate from phase 1, so D6's actual purpose (never two concurrent agents inside one file) still holds. P3.1 therefore edits them as the sole live editor of each, in the shape D6 protects rather than around it.

Owns: `packages/contract/src/ops.ts`, `packages/cezar/src/server/ops-routes.ts`, `packages/cezar/src/ops/{store,types,ids,index-cache}.ts` plus tests, and the six chokepoint edits from the blast-radius table **granted by D22b**. Explicitly **not** `CHANGELOG.md`, which the plan gives to W5.2. Deps: none beyond the preconditions.

### P3.2 Git transport and push-as-CAS lease (M)

Hardened git plumbing (the `skills-remote.ts:43-54` argument set, reused verbatim) and the lease with TTL, holder record, heartbeat and fencing token. Owns `packages/cezar/src/ops/{git-store,lease}.ts` plus tests. Deps: P3.1.

### P3.3 Notion importers reusing the W1.4 client (L)

Tickets, the knowledge split, capture and changelog. **Reuses W1.4's client and block-to-Markdown converter rather than writing a second one**, which is the one place this phase depends on phase 1 code rather than only on phase 1 having shipped. Owns `packages/cezar/src/ops/notion/{export,import-tickets,import-knowledge,import-capture}.ts`, fixtures, tests. Deps: P3.1, W1.4.

### P3.4 Reconciler: census, per-row digest diff, behavioural replay with red controls (L)

Owns `packages/cezar/src/ops/reconcile/{digest,reconcile,replay,report}.ts`, fixtures, tests. Deps: P3.1, P3.3. **This package is the gate for P3.5**: no surface flips before its red controls pass.

### P3.5 Mirror engine: per-surface authority, reversible by config, drift reporting (M)

Both directions implemented and tested from the first commit. Owns `packages/cezar/src/ops/mirror/{engine,drift}.ts` plus tests. Deps: P3.3, P3.4.

### P3.6 Ops cockpit, `cez ops` CLI, lease-aware dispatch (M)

The board, the ticket detail, the comment composer (the second human's write path that is not a git push), the CLI, and `notify`. Owns `packages/web/src/routes/ops/*`, `packages/web/src/lib/ops-board.ts`, `packages/cezar/src/ops/{cli,notify}.ts` plus tests. Deps: P3.1, P3.2. **M4's flip cannot happen before this ships and the second human has used the composer once.**

### P3.7 Skill and doctrine rewrite (workspace repo, SOLO) (M)

`notion-sync` becomes `ops-sync` and the chat loop becomes `ops-loop`, with the procedure kept nearly verbatim (the procedure is the hard-won part, only the verbs change), plus the knowledge-first read order re-pointed in `/Users/mw/loki-labs/CLAUDE.md` and `/Users/mw/loki-labs/AGENTS.md` with the old paragraph marked **superseded in place** per rule 3a. Deps: P3.5, P3.6.

Three constraints on this package specifically:

- **SOLO, and serialized even though it is a different repo.** Those two files are read first by every session in the workspace; a concurrent edit corrupts the doctrine every other agent is reading.
- **Its target files are dirty right now.** `git status` at the workspace root shows modified `.claude/skills/notion-sync/SKILL.md`, `AGENTS.md` and `CLAUDE.md`. By this workspace's own doctrine (dirty path equals owned), P3.7 cannot start until those are committed by whoever owns them.
- **Step numbering is load-bearing.** `log-watch` and SPEC-075 cite the loop's step 5 by number. Do not renumber.

### Not a phase-3 package, but gating it

**W1.9** (`report_issue` D1 dual-write, chat repo) is a phase-1 wave-1 package. Its acceptance needs seven consecutive days of exact Notion-and-D1 agreement, which makes it the longest-lead item in the plan. The correction recorded in PLAN.md applies: the chatbots worker has **no `d1_databases` binding and no `migrations/` directory**, so that package adds both.

## Risks

- **Shared-instance auth is unresolved and this spec does not resolve it.** Everything about two humans on one board is blocked on it. Mitigation: phase 3 ships single-instance loopback-only, and the multi-human surface is not built until the owner answers. `assignee` remains a free string, which is honest but is not safe on a shared port. See Open Questions.
- **PII is permanent once pushed.** Mitigation: the hard-failing write guard, the HMAC `reporterRef`, the resolution table on the chat side, and a remote that starts absent. The residual risk is a PII shape the guard does not match (a handle written in an unusual format inside a pasted quote). Accepted, mitigated by the guard also running over comment bodies, and reviewed if it ever fires.
- **The push credential is a new secret with no home.** `skills-remote.ts` hardening is for read-only bare clones; this pushes, from a headless loop. Open Questions, item 3.
- **A rejected push under contention can livelock.** Mitigation: exactly one bounded retry, and only when the remote head moved for an unrelated file; a genuine lease conflict is reported with the winner's holder record rather than retried.
- **Offline claims are advisory.** An agent on a plane cannot claim a ticket, which is the offline property the git model was chosen for. Mitigation: Q6's two-tier degradation, loud, with the losing branch preserved.
- **Heartbeat commit noise.** Roughly 480 commits per day per continuously-held lease. Mitigation: `cez ops gc`, monthly changelog files, and a 10-minute TTL rather than a 60-second one.
- **A Notion write that fails is permanent if retried.** A 402 on a plan limit or a 500 leaves the ops entity correct; the mirror emits drift and does **not** retry, because there is no delete tool on that surface and a duplicate cannot be removed.
- **The Knowledge split is the phase most likely to lose content silently**, and it is the document every session reads first. Mitigation: it migrates last, the splitter is byte-exact and reversible, and the join must be byte-identical to the M0 export before the flip is permitted.
- **The second human can be stranded by ordering.** Mitigation: comments flip last, and M4's exit criterion is his successful use of the composer, not a date.
- **The replay could agree while both sides are wrong.** Mitigation: frozen snapshot versus live re-fetch, a 5% live cross-check, and the two seeded historical bugs that must produce divergence.
- **Upstream merge tax, forever.** Mitigation: the six-line blast radius, the two containment tests in both directions, and one contiguous BC block. Residual: `server.ts` is one of upstream's highest-churn files, so a conflict on that single line is expected at most merges and is a one-line resolution.
- **The e2e suite is a global mutex.** One browser, port 4321, `.ai/qa/test-env.lock`, `fileParallelism: false`. No package in this phase runs `npm run test:e2e` except the plan's W5.1 owner, and `TEST_E2E_STATUS=skipped` is not a pass (`.ai/scripts/e2e.sh:6-12`).
- **The QA label gate is not satisfied by green tests.** `SDLC.md:69-71`: a PR carrying `needs-qa` must not merge without `qa-approved`, even when every other check is green. This is a user-facing cockpit feature, so it carries `needs-qa`; the self-QA exception requires attached evidence.

## Verification

Gates green is necessary and not sufficient. Every control below that can be written as a negative control is written as one, because a test that passes whether or not the mechanism works proves nothing.

### The negative controls, and what must fail

| # | Mechanism | Disable this | The control must then FAIL |
|---|---|---|---|
| N1 | Cross-machine mutual exclusion | Run the two-clone test against a single clone | The two-clone test. A test that exercises one clone passes without any lease at all and proves nothing about a second machine. |
| N2 | Loud expiry reclaim | Suppress the `lease-reclaimed` changelog line or the event | The expiry test asserts **both** the changelog line and the event. A silent reclaim is the orphaned-lock bug returning. |
| N3 | Fencing | Ignore `fencingToken` on write | The zombie test: a holder with a stale token must have its write **rejected**, not merged. |
| N4 | Reconciler sensitivity | n/a, this is the red suite | Deleting one row must give exactly `missing:1`; one changed character exactly `differing:1`; one unknown `notionId` exactly `extra:1`. If any of the three still reports zero, the reconciler is decorative. |
| N5 | Replay honesty | n/a, invert the assertion | The replay seeded with the page-2 false empty and the stale project filter must report **divergence**. A replay reporting agreement there is itself broken, so the assertion is `toBeDivergent`, not `toAgree`. |
| N6 | PII guard | Feed a fixture report containing an E.164-shaped handle | The write must **throw** and the file must not exist on disk. A warning that still writes is not a guard. |
| N7 | Gitignore containment | Add an `ops` entry to `ensureDataGitignore`'s `wanted` array (`packages/cezar/src/index.ts:666-683`) | The containment test. A gitignored board is not a board. |
| N8 | Flag-off inertness | Set `CEZ_OPS=1` while running the flag-off suite | Every mutator-409 and empty-GET assertion. The suite also asserts that **no route in the family answers `404` with the flag off** (Q2, D19), so a handler that goes missing rather than empty is red. |
| N9 | Store salvage | Corrupt one ticket's front matter | The read must return `n - 1` tickets with one warning, **not** zero and not a throw. Asserting `> 0` would pass on a broken salvage; the assertion is the exact count. |
| N10 | Index derivation | `rm -rf .index/` then read | Results must be identical. If the index held anything authoritative, this fails. |
| N11 | Digest pinning | Change a `normalize()` rule without the fixture | The suite must fail, or a future diff can be made to disappear by loosening the comparator. |
| N12 | Dedupe by write | Import two rows sharing one `notionId` | The second `O_EXCL` create must fail and be reported. Silent overwrite is the failure. |
| N13 | Notify grouping | n/a, assert the absence | Three shipped tickets sharing one `(agentId, chatId)` produce exactly **one** POST with a three-item array, and the module must export no single-report function. Asserting the absence is what makes the rule unreachable rather than discouraged. |
| N14 | Mirror authority split | Flip a surface's direction in **config only** | With `changelog: ops` and `tickets: notion`, an ops-side ticket edit must be reverted by the next cycle and a Notion-side changelog edit must be reported as drift. If both survive, the split does not split. |
| N15 | Pagination | Read one page and assert emptiness on it | `enumerateAll` must return both pages; a single-page read must report `complete: false`, and asserting emptiness on it must throw. This is the approximately 45-tick false-empty bug made unreachable by construction. |
| N16 | Lease `state` is persisted, not derived (D20) | Compute `state` from `expiresAt` versus the clock at read time, or filter `GET /ops/leases` to non-expired rows | The lease parity control: with one lease whose `expiresAt` falls between two of three back-to-back reads and no transition running in between, `GET /ops/tickets/:ticketId` and `GET /ops/leases` must answer **byte-identically** all three times, and the un-reclaimed row must still be present in the listing. Either mutation makes one of the three bodies differ, which is the flaky `route-parity` red gate D8 exists to prevent. The positive half is separate: after the reclaim transition runs, `state` must read `expired` and the notice from N2 must have been emitted. |

### Validation

Run from `/Users/mw/loki-labs/cezar`, in **its own git worktree with its own `npm ci`** (`pretypecheck` writes `packages/cezar/dist`, so two agents running the gate in one checkout corrupt each other).

**The gate is exactly these five commands, in order. There is no lint step and no format step in cezar.**

```
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

Per-package targeted runs:

```
# P3.1
npm test -- packages/cezar/src/ops/store.test.ts packages/cezar/src/ops/ids.test.ts packages/cezar/src/ops/index-cache.test.ts
npm test -- packages/cezar/src/server/ops-routes.test.ts        # N8, N9, N10, N16
npm test -- bc-route-inventory versioned-surface route-parity   # the drift guards
npm run typecheck                                               # contract-parity.ops, both directions

# P3.2
npm test -- packages/cezar/src/ops/lease.test.ts                # N1, N2, N3, N16 (the reclaim transition that writes `state`)
npm test -- packages/cezar/src/ops/git-store.test.ts            # asserts protocol.ext.allow=never and GIT_TERMINAL_PROMPT=0 on every invocation

# P3.3
npm test -- packages/cezar/src/ops/notion/                      # N12, N15
npm test -- packages/cezar/src/ops/pii.test.ts                  # N6

# P3.4
npm test -- packages/cezar/src/ops/reconcile/                   # N4, N5, N11

# P3.5
npm test -- packages/cezar/src/ops/mirror/                      # N14

# P3.6
npm test -- packages/web/src/routes/ops/ packages/web/src/lib/ops-board.test.ts
npm test -- packages/cezar/src/ops/cli.test.ts packages/cezar/src/ops/notify.test.ts   # N13
```

Structural assertions that no test file can express, run as commands:

```
# N7: the ops store must NOT be swept into ensureDataGitignore
node -e "const s=require('fs').readFileSync('packages/cezar/src/index.ts','utf8');const i=s.indexOf('const wanted');if(/ops/.test(s.slice(i,i+900)))throw new Error('ops state must NOT be gitignored');console.log('ok')"

# the env contract and the route inventory are updated in the same commit
grep -q 'CEZ_OPS' .env.example
grep -q '/api/v1/ops' BACKWARD_COMPATIBILITY.md

# D2 containment: no Loki string in upstreamable code
grep -rniE 'lokimessages|beside\.chat|predicts\.chat|imsg-agent' packages/cezar/src packages/contract/src packages/web/src --exclude-dir=ops && exit 1 || echo 'ok: no Loki string outside src/ops'

# D2 containment, the other direction: nothing outside src/ops imports from it, except the chokepoints
grep -rn "from '.*\/ops\/" packages/cezar/src --exclude-dir=ops | grep -v 'server/ops-routes.ts' && exit 1 || echo 'ok: ops imported only by its route family'
```

Migration validation, run against the real export rather than a fixture:

```
cez ops export --dry-run                 # M0: census reproducible, twice, identically
cez ops reconcile --surface changelog    # M2 exit criterion
cez ops reconcile --surface tickets      # M4 exit criterion, 7 consecutive green days
cez ops knowledge join --verify          # M6: sha256(rejoined) === sha256(export)
```

### Runtime and QA, because gates green is not done

- **Two real machines, not two clones on one.** The two-clone test (N1) proves the CAS property; it does not prove the credential, the network path, or the clock skew between two hosts. The device pass is: claim the same ticket from the dev Mac and the Mac mini within the same second, and confirm exactly one grant and one holder record naming the winner's machine.
- **`npm run test:e2e` is owned by the plan's W5.1 alone**, and `TEST_E2E_STATUS=skipped` is not a pass. The ops e2e posts a comment through the cockpit composer and asserts it lands in `tickets/<id>.comments.ndjson`.
- **The PR carries `needs-qa`** and does not merge without `qa-approved` (`SDLC.md:69-71`). The self-QA exception requires the PR checked out, the flow exercised, and evidence attached, plus both `qa-approved` and `qa-self-verified`.
- Until the two-machine pass and the composer pass have both happened, the Notion task stays **QA Needed**, not Done.

## Open Questions

**1. Shared-instance auth. This is the sharpest hole in the entire programme, and it is an owner decision.**

Stated plainly: cezar today has a loopback `Host`/`Origin` guard (`packages/cezar/src/server/capabilities.ts:105-116`, where `isLoopbackHostHeader` is the untrusted-input twin that fails closed on a missing host) and a per-repo `launch-key` (`packages/cezar/src/server/launch-key.ts:5-10`) whose entire purpose is that a rogue web page cannot read it, so `/new?auto=1` only prefills the form. That is the whole story. `resolveCapabilities` (`capabilities.ts:126-140`) returns `localHandoff`, `followups`, `singleProject` and three metrics flags. There is **no bearer token, no user identity, no per-project ACL, no rate limit and no CORS design**; `/api/v1/health` is the only CORS-open route (`BACKWARD_COMPATIBILITY.md:22`).

Two humans on one board with no login means **`assignee` is a free string that anyone who can reach the port may set**, and so is `status`, and so is a comment's `author`. Worse, the mode a shared board needs is hosted mode (`CEZ_REMOTE=1`), and in hosted mode the existing convention is that local-machine mutators answer 409, which is the opposite of what a shared board wants.

This spec does not pick a default here, because a default would be a security posture chosen by an agent for a board holding another person's data. The question for the owner is which of these: (a) a shared bearer token in `~/.cezar/`, cheap and with no identity, so `author` stays unverifiable; (b) per-user tokens mapped to a `members[]` list in `ops.json`, which gives real attribution and needs a token lifecycle; (c) no shared instance at all, each human runs their own cezar and the git remote is the only shared surface, which is the smallest change and gives up the live board; (d) put the instance behind an existing identity proxy and accept the dependency. Option (c) is the only one that requires no new cezar auth code, and it is the one this spec is written to still work under.

**2. Is a fork of a published npm package the right home at all?**

Recorded as a **genuine alternative that was never evaluated, not as a recommendation to change course.** D1 settled that cezar is the host by owner decision, and that is not being re-litigated. But the observation stands on its own: this phase is fork-private by construction (D2), so it never receives the benefit that the fork's tax buys. The tax is real and per change: seventeen new routes each needing a `BACKWARD_COMPATIBILITY.md` entry, a contract-parity assertion, a `typed-bodies` row and a contract schema; a hard `qa-approved` merge gate; a route inventory checked mechanically; both-direction contract parity through `npm run typecheck`; and a permanent conflict line in `server.ts`, one of upstream's highest-churn files. A small standalone tool in `~/loki-labs` or in the `ops` repo itself, with the same file store, the same lease and a CLI, would pay none of it and would lose the cockpit UI and the run integration. Nobody has costed that trade, and it is worth costing before P3.1 lands, because adding seventeen routes is what makes the answer irreversible.

**3. Where does the ops repo's push credential live?**

The lease and the durability substrate both depend on `git push` from a headless loop. `skills-remote.ts:43-54`'s hardening covers read-only bare clones and says nothing about credentials. Options: an SSH deploy key per machine in the agent's own home (not in any repo), a fine-grained token in the OS keychain, or a credential helper. This needs an answer before P3.2, and the answer must not be an environment variable committed to `.env.example`, which is a documentation surface and not a secret store.

**4. Is a private GitHub repo the right home for the board even after redaction?**

The PII rule removes handles, chat ids and agent ids. It does not remove the fact that ticket bodies quote user reports, that the changelog names what shipped when, and that the knowledge corpus is the workspace's entire decision record. That is a business-confidential corpus on a third-party host with a shared blast radius. The alternative is a self-hosted remote, which costs an operational dependency this programme has otherwise avoided. Worth a deliberate answer rather than a default.
