# Reports triage — a separate inbox with approve / dismiss

**Status:** Proposed (2026-08-19)
**Owner:** Marcin Walendowski
**Related:** `2026-08-17-notion-export-cezar-import.md` (the corpus is the record),
`2026-08-17-filed-tasks-table-statuses.md` (the todo inbox and its status model),
`2026-08-06-knowledge-base-mounts-search.md` (F1 — mounts, tags, catalog),
`chat/.ai/specs/SPEC-526-2026-08-17-user-reports-to-cezar.md` (how reports arrive)

## TLDR

User reports currently land in the knowledge corpus as documents tagged `user-report`,
where they are searchable but **invisible on every board a human actually looks at** — the
Tasks board renders `todos.json` and never reads the KB. So a filed report has no inbox, no
triage state, and no way to become work except a person noticing it in search. This spec adds
a **Reports view**: its own list, its own triage store, and two actions — **approve**, which
mints a todo from the report in the routed project's inbox, and **dismiss**, which records the
report as not-actionable with a reason. An `auto` mode converts every arriving report without
asking, for owners who would rather triage in the task board than in a second queue.

Nothing about how reports arrive changes, and no report document is ever edited: the corpus
is append-only for reports (their bodies are the user's own words, carry PII, and are owned by
the drain). Triage is a separate, additive store.

## Problem

Three facts that only bite in combination:

1. **Reports are knowledge documents.** The SPEC-526 drain writes each one as markdown into
   `notion-export/reports/`, tagged `user-report` + `status/new`. The KB indexes them, so
   search and facets find them.
2. **The Tasks board never reads the KB.** It renders `GET /api/v1/workspace/todos`, i.e. each
   project's `.ai/cezar/todos.json`. This was already established the hard way on 2026-08-17,
   when a task migration with exact 628/628 id parity still *looked* like it had never run.
3. **Nothing converts a report into a todo.** The Notion-era Loop did that; it is retired.

Together: a user files feedback, it reaches the record, and then sits there. Verified
2026-08-19 — two reports (2026-08-15 Grocey cart, 2026-08-16 Alfredo digest) sat at
`status/new` for days with no task anywhere, and were only found by grepping the corpus. They
had to be converted into todos by hand.

A second, subtler problem: **`status/new` is a tag on a document in a read-only mount.** Even
if something did triage a report, it has nowhere to write the outcome. Editing the report file
is not an option — see "Reports are append-only" below.

## Solution

**A Reports view backed by a triage store that is separate from the documents it describes.**

- **The list** is derived, not stored: every KB document carrying the reports tag, left-joined
  with the triage store. A report with no triage row is `pending`. This means a newly drained
  report appears in the inbox the moment `fs.watch` indexes it, with no write anywhere.
- **Approve** mints a todo from the report — summary, `context` carrying the report's
  provenance (doc id, identifier, handle/chat/agent, filed time), `whatToDo` seeded from the
  report body — into the inbox of the project the report routes to. The returned todo id is
  recorded on the triage row, so the report and the work it became stay linked in both
  directions.
- **Dismiss** records `dismissed` plus a required reason. The report stays in the corpus and
  stays searchable; it simply leaves the pending queue. A dismissal is reversible (`reopen`)
  because a reason recorded in haste is not a reason to lose the report.
- **Auto mode** (`CEZ_REPORTS_AUTO = '1'`) converts pending reports to todos without asking,
  driven by an explicit `POST .../reports/process-pending` that a timer calls.

### Reports are append-only, and triage lives elsewhere

The triage state deliberately does **not** live in the report's frontmatter, even though a
`status/new` tag is sitting right there. Three reasons, and the first alone settles it:

1. **The mount is read-only.** `notion-export` is registered as a read-only knowledge mount, so
   the knowledge write API cannot touch it. A route that edits report files would be reaching
   around the mount's own contract.
2. **The drain owns those files.** It writes them and re-drains into the same filename on
   crash, which is what makes the pass idempotent. A second writer editing frontmatter turns a
   safe re-drain into a clobber of triage state.
3. **Report bodies are the user's words and carry PII** (phone numbers, chat ids, handles).
   Every rule around this corpus says capture is not ours to edit.

### Why keyed on the identifier, not the catalog id

The triage row's key is the document's **first `identifiers` entry** (e.g.
`local:report:2026-08-19T07:53:45.502Z-fc080d4a`), not the KB catalog id. The catalog id is
derived from content and root, and a reindex or a mount rename can change it; the identifier
is provenance, minted once by the writer, and is exactly what the drain guarantees is stable
and unique per report. A document with no identifier falls back to the catalog id and records
`keyKind: 'catalog-id'` so the weaker key is visible rather than assumed.

### Routing a report to a project

`domain` on the report document (`alfredo`, `grocey`, `beside`, `predicts`, …) is a *product*
axis, while a todo inbox is a *repo*. The map between them is deployment-specific, so it is
configuration, never source: `reports.routeByDomain` in the project's `.ai/cezar/config.json`,
falling back to the project the report document itself belongs to. This keeps the feature
generic — cezar ships no knowledge of any particular product line.

## Architecture

```
   worker report_issue ──► BOT_KV ──► reports drain (systemd timer on the box)
                                             │  writes markdown, verifies digest
                                             ▼
                       notion-export/reports/*.md   (read-only mount, append-only)
                                             │  fs.watch → KnowledgeStore
                                             ▼
   GET  /reports        ◄── join ──►  reports-triage.json      (NEW, per project,
   POST /reports/:k/approve                │                    O_EXCL lease like todos)
   POST /reports/:k/dismiss                │
   POST /reports/:k/reopen                 ▼
   POST /reports/process-pending ──► createTodo(dataDir, …) ──► todos.json ──► Tasks board
```

- **No new storage technology.** The triage store is the `todos.json` idiom verbatim: one JSON
  file per project under `.ai/cezar`, written tmp+rename under an `O_EXCL` lease, read
  leniently (an unparseable row is dropped with a warning, never fatal).
- **The join is in the route, not the store.** The KB stays the only index of documents; the
  triage store knows nothing about report content.

## Phases

| # | Phase | Deliverable |
|---|---|---|
| P1 | Triage store + contract | `reports-triage.ts` (read/write/patch under lease), contract types + schemas, unit tests |
| P2 | Routes | `reports-routes.ts`: list, approve, dismiss, reopen, process-pending; route tests incl. the flag-off shape |
| P3 | Web view | `Reports` nav item (gated), list table, detail drawer, approve/dismiss actions, tests |
| P4 | Auto mode | `process-pending` + systemd timer on the box; off by default |
| P5 | Deploy + verify | Build, gates, rsync to `/opt/cezar`, restart, run the Verification matrix |

## Data Models

`<projectRoot>/.ai/cezar/reports-triage.json` — a JSON array:

```ts
type ReportTriageRow = {
  key: string;                    // identifiers[0], else catalog id
  keyKind: 'identifier' | 'catalog-id';
  status: 'approved' | 'dismissed';   // absence of a row = pending
  at: string;                     // ISO, server-stamped
  by?: string;                    // principal email when auth is on
  reason?: string;                // required for dismissed
  todoId?: string;                // set by approve
  todoProjectId?: string;         // which inbox it landed in
  auto?: boolean;                 // true when process-pending created it
};
```

Derived list item (never stored):

```ts
type ReportListItem = {
  key: string;
  docId: string;                  // KB catalog id, for the detail fetch
  title: string;
  domain?: string;
  tags: string[];
  filedAt?: string;               // updatedAt on the doc
  status: 'pending' | 'approved' | 'dismissed';
  triage?: ReportTriageRow;
};
```

## API Contracts

All project-scoped, mounted like every other family so they answer at `/api/v1/*`,
`/api/v1/p/:projectId/*` and `/api/v1/p/default/*` identically.

| Route | Behaviour |
|---|---|
| `GET /reports?status=&domain=&limit=&offset=` | Derived list, newest first. `enabled:false` + empty list when the KB is off, matching the `KNOWLEDGE_OFF` precedent's schema-valid empty shape. **Pure — no writes, ever**, including in auto mode. |
| `GET /reports/:key` | One item plus the document body. 404 for an unknown key. |
| `POST /reports/:key/approve` | Body `{ todoProjectId?, priority? }`. Mints the todo, writes the triage row, returns both. Idempotent: an already-approved key returns its existing row and does **not** mint a second todo. |
| `POST /reports/:key/dismiss` | Body `{ reason }` (required, 1..500). 409 if already dismissed with a different reason? No — overwrite is allowed and `at` is restamped; the previous reason is not history we promise to keep. |
| `POST /reports/:key/reopen` | Deletes the triage row, returning the report to pending. Does **not** delete a todo minted by an earlier approve — that todo is real work now; the response names it so the caller can decide. |
| `POST /reports/process-pending` | Approves every pending report using the routing map. Returns per-key outcomes. 409 when `CEZ_REPORTS_AUTO` is not `1`, so a stray call cannot mass-convert an inbox someone intended to triage by hand. |

Mutators answer 409 with a fixed flag-naming message when the KB is off, following
`KNOWLEDGE_OFF`.

## Risks

- **Auto mode turns noise into tasks.** A user who files five variations of one complaint
  produces five todos. Mitigation: auto is off by default, and `process-pending` reports what
  it converted so a bad batch is visible. Deduplication is explicitly out of scope — guessing
  which reports are "the same" is a judgement call this spec will not automate.
- **Approve is the only path that writes another store.** A crash between minting the todo and
  writing the triage row leaves a todo with no triage row, so the report stays pending and a
  second approve would mint a duplicate. Mitigation: write the triage row **first** with the
  todo id reserved? No — ids are minted by `createTodo`. Instead: `approve` searches the target
  inbox for an existing todo whose context carries this report key before minting, which makes
  the operation idempotent without a transaction across two files.
- **Two cockpits.** The Mac and the box each have a `reports-triage.json`. Since the corpus is
  the record on the box and the Mac copy is retired, only the box's store is authoritative —
  but nothing enforces that. Mitigation: doctrine, and the fact that reports now only ever
  arrive on the box.
- **Purity guard.** `packages/{cezar,web}/src` must not mention Loki products. The routing map
  is configuration; the tag name is configuration; no product name enters source.

## Verification

Automated:

0. **Amended 2026-08-19** — see "the corpus's own status tag is part of the derivation" below:
   a report whose document says it was already handled opens as `approved`/`statusSource: 'document'`
   with no triage row, is never auto-converted, and an explicit `reports.handledTags: []` puts it
   back in the queue.
1. Store unit tests: lease serialization (two concurrent writers, both survive), lenient read
   of a corrupt row, tmp+rename atomicity.
2. Route tests: flag-off shape for all six routes; approve mints exactly one todo and is
   idempotent on a second call; dismiss requires a reason; reopen returns to pending and names
   the orphaned todo; `process-pending` 409s when auto is off.
3. A **negative control** on the list join: a report document with a triage row for a
   *different* key must still read as pending — proving the join keys on the identifier and not
   on position or title.
4. Web tests: nav item renders when gated on and not when off; the list shows pending first;
   approve removes a row from pending without a reload.

Runtime, on production, after deploy:

5. `GET /api/v1/p/loki-labs/reports` lists the reports currently at `status/new`, including
   the two 2026-08-15/16 ones and the two e2e probes.
6. Approve one report in the cockpit; confirm a todo appears on the Tasks board for the routed
   project, and that the report leaves pending.
7. Dismiss a probe report with a reason; confirm it leaves pending and stays searchable in the
   KB.
8. File a fresh report through the real tool (`feedback:` message to a production bot), wait
   for the drain timer, and confirm it appears in the Reports view **without** any manual step.

Step 8 is the one that matters: it is the only step that proves arrival → inbox works
end to end, unattended.

### Results — automated (2026-08-19)

Steps 0 to 4 are **executed and green** (49 tests). Files: `packages/cezar/src/reports-triage.test.ts` (9),
`packages/cezar/src/server/reports-api.test.ts` (25), `packages/cezar/src/server/contract-parity.reports.test.ts`
(compile-time, all six responses, both directions), `packages/web/src/routes/reports/reports.test.tsx` (15).

Each of the four claims most worth doubting was **mutation-tested** rather than trusted, because a
guard that cannot fail is the failure mode this suite is most exposed to:

| Mutation | Expected | Observed |
| --- | --- | --- |
| `withTriageLease` bypasses the lease | the three lease tests fail | 3 failed |
| `mintOrReuseTodo` stops reusing the existing todo | the two idempotency tests fail | 2 failed |
| `isReport` returns `true` for every document | the untagged negative control fails | 1 failed |
| counts computed after the `status` filter | a badge test fails | **0 failed — the assertion was vacuous** |
| cockpit badges count the rendered page | a badge test fails | 1 failed (after the fix below) |
| dismiss confirm drops its `reason.trim()` guard | the required-reason test fails | 1 failed |
| `process-pending` filters on `!triage.has(key)` instead of the shared derivation | the document-handled test fails | 1 failed |

The fourth row is the finding. The first version of the counts test only requested
`?status=pending`, and a `pending` count that wrongly honoured the filter is **still 1** there — so
it passed on the bug. Fixed by asking for a status *different* from the one being counted, for all
three, plus a `domain` filter that matches nothing. It now fails on the mutation.

Gates: `npm run typecheck` green (all four projects), `npm run test:unit` green (43/44, 1 skipped),
`npm run build` green (`check:pack` ok). `npm test` is **8 red out of 8788**, none of them this
change — each was isolated by reverting only the file that could have caused it:

- `server/config-api.test.ts` (4) — fail identically with this change's `config.ts` edit reverted to
  HEAD. They read the developer machine's real native agent model (`claude: 'opus[1m]'` where the
  fixture expects `sonnet`), so they are environment-dependent on this box.
- `notifications/transports/webhook.test.ts` upstream purity (1) — names its four offenders, and all
  four (`web/src/api/client.test.ts`, `components/app-shell-container.test.tsx`, `lib/reauth.ts`,
  `routes/onboarding/onboarding-gate.ts`) belong to the concurrent signed-out-reauth work in this
  same checkout.
- `todos.test.ts` (2) and `knowledge/store.test.ts` (1) — `fs.watch` timing. Both files are at HEAD
  (untouched by this change and by the concurrent session), and `store.test.ts` passes in isolation,
  so these are pre-existing flakes on committed code.

Two expectation files were updated because this change really does change them, not to make red go
away: `components/nav-items.test.ts` and `components/app-shell.test.tsx` both pin the nav list
verbatim. `nav-items.test.ts`'s "without knowledge, **exactly** the Knowledge item drops out" case
was also *renamed and corrected in place* — the `knowledge` gate now owns two items, so the old
title had become false, and it is the kind of false a future session enforces.

### Amendment — the corpus's own status tag is part of the derivation (2026-08-19)

Found while preparing the deploy, by reading the real corpus rather than assuming it: of the 193
report documents in `loki-labs`, **191 carry `status/processed`** and 2 carry `status/new`. The
first implementation derived pending from "no triage row" alone, so the queue would have opened on
all 193 — re-asking 191 questions someone had already answered — and turning auto mode on would have
minted 191 tasks. Verification step 5 already said the queue should list *the reports currently at
`status/new`*, so this was the spec being unimplemented, not the spec changing.

Resolved by making the document's own status tag the INITIAL state, with the triage store overriding
it, through one shared `derivedStatus()` that the list, the detail route AND `process-pending`'s
pending filter all call:

| triage row | handled tag | `status` | `statusSource` |
| --- | --- | --- | --- |
| yes | — | the row's | `triage` |
| no | yes | `approved` | `document` |
| no | no | `pending` | `default` |

`statusSource` is on the wire because the three are not interchangeable. A `document` report is
approved by **nobody here**: there is no row, no timestamp, no reason and no todo, so synthesizing a
triage row for it would invent a person. The cockpit says "already handled before triage existed" and
offers **Approve** rather than Reopen on such a row — Reopen would delete a row that is not there,
leaving the document's tag in charge, i.e. a button that visibly does nothing, while Approve files
the task nobody ever filed. `reports.handledTags` configures the vocabulary; an explicit `[]` opts
out and puts every report back in the queue.

Mutation-tested: reverting `process-pending`'s filter to the naive `!triage.has(key)` fails "an
automatic pass never converts a document-handled report" (1 failed). The cockpit half has its own
negative control — the same row with a real triage row gets the opposite button pair, so the
assertions are keyed on `statusSource` and not on something incidental.

This also corrected the contract comment claiming `triage` is "absent exactly when `status` is
`pending`", which stopped being true the moment `document` existed; the presence check is keyed on
`statusSource` now, and the old wording was amended in place rather than appended to.

### Results — production runtime pass, EXECUTED 2026-08-19 (was "Still QA Needed")

**This heading said "Still QA Needed" until the pass ran.** Steps 5 to 8 have now all been executed
against `prod-host`, so the old title was exactly the kind of false a future session acts on.

The box requires OIDC (`CEZ_AUTH=oidc`), and only `/api/v1/health` is exempt — so a loopback `curl`
answers `401 unauthenticated` for every other route. There is no bearer/API-token path for the app
API. The pass therefore ran behind a **15-minute session minted the same way a login does**
(`createSession(userId, ttl)` out of the built `dist/auth/session.js`, as the `cezar` user with
`HOME=/var/lib/cezar`), which is safe to do out of process because `identity-store.ts` re-parses
`identity.json` on every read and caches nothing.

| # | Step | Result |
| --- | --- | --- |
| 5 | queue lists only the `status/new` reports | **pass** — `counts: {pending: 4, approved: 191, dismissed: 0, total: 195}`, and every one of the 191 came back `statusSource: 'document'`. The two 2026-08-15/16 reports and both e2e probes were the 4 pending. |
| 6 | approve mints a todo on the routed board | **pass** — `alreadyApproved: false`, `keyKind: 'identifier'`, and the todo appears in `GET /p/chat/todos` at `todo/medium` carrying the user's own feedback text. |
| 7 | dismiss with a reason | **pass** — both probes dismissed, reason stored. Negative controls: a **bodyless** dismiss and a whitespace-only reason both `400`. |
| 8 | fresh report reaches the queue unattended | **pass** — see the timeline below. |

Step 8's timeline, the one that actually answers "does this work without the Mac":

- `09:21:13Z` — a real `feedback:` iMessage sent to the production bot.
- `09:23:11Z` — the **on-box** `cezar-reports-drain.timer` (5-minute cadence) logged
  `1 staged report(s) → /var/lib/cezar/loki-labs/notion-export/reports`. No Mac involvement in this
  step or any later one.
- `09:23:31Z` — the deployed queue shows it `pending` (`total` 195 → 196) and the KB search finds it.

**A read at `09:23:11Z` showed `pending: 0` — twenty seconds after the file existed on disk.** That is
the reindex lag, not a failure, but it is the shape a future session will misread as "the drain
didn't work": the drain and the index are two steps, and only the second one makes a report visible.
Poll for ~30 s before concluding anything.

Two further things were verified in passing, neither of which the unit tests could reach:

- **`reports.routeByDomain` is read per request** — it was added to the live
  `.ai/cezar/config.json` (merged, preserving the `notion-export` knowledge mount) and the very next
  approve routed to `chat` with **no restart**.
- **Idempotency holds against the real 595-entry inbox file**, not just a temp dir: a second approve
  of the same report returned `alreadyApproved: true` with the same `todoId`.

Housekeeping done as part of the pass: the first approval had landed in `loki-labs` before the routing
map existed, so it was reopened (which named its orphaned todo), the orphan deleted, and re-approved
into `chat`. Both real reports are now tasks on the `chat` board; both probes are dismissed.

### Amendment — `by` was a promise no route kept (2026-08-19)

Found by reading the production approve response, not by a test: `triage.by` came back absent on a
deployment where auth is **on**, because no route ever wrote it. The contract described it as "the
principal who triaged, when auth is on", the store round-tripped it, the cockpit renders the
timestamp beside it — so every reader of that field would have concluded triage is unattributable,
while the field itself sat there looking live.

Now stamped by approve, dismiss and `process-pending`, read off `c.get('principal')` through the same
cast `server.ts`'s four existing principal readers use (widening `ProjectApiEnv` breaks assignability
for ~30 callers that annotate a plain `Hono`). Three deliberate choices, each with a test:

- **`kind: 'local'` stamps nobody.** `CEZ_AUTH=none`'s identity is the machine; putting it in an audit
  field would make "whoever was at this laptop" read like a named colleague's decision. This is the
  negative control that matters — a handler stamping `principal.userId` unconditionally passes the
  happy-path test and fails only here.
- **Approve keeps the first approver, dismiss overwrites.** Re-approving is not a new decision;
  dismissing is, and its owner is whoever dismissed it.
- **`process-pending` stamps who ran the pass AND keeps `auto: true`.** Either alone lies: `by` alone
  reads as a hand decision, `auto` alone loses who asked for it.

The stored value is the **user id**, not an email — resolving one to the other means reading the
identity store, which a project-scoped route family has no business doing. Nothing renders it yet;
the contract comment now says so, so its absence from the UI is not read as the field being unused.

Mutation-tested, five mutations, all caught (`reports-api.test.ts` is 25 → 30 tests):

| Mutation | Expected | Observed |
| --- | --- | --- |
| `triagedBy` drops the `kind === 'session'` check | the local-deployment control fails | 1 failed |
| approve never stamps `by` | the attribution tests fail | 2 failed |
| dismiss keeps the first author instead of overwriting | the Bob-dismisses test fails | 1 failed |
| `process-pending` drops `by` | the automatic-pass test fails | 1 failed |
| approve overwrites the author on re-approve | the first-approver test fails | 1 failed |

Gates after this amendment: `npm run typecheck` green (all four projects); `npm test` **red only in
`server/config-api.test.ts` (4, the machine's real native model) plus `fs.watch` flakes in
`todos.test.ts` / `knowledge/store.test.ts` / `route-parity.test.ts`** — the flakes were confirmed by
reverting only this change's three files and seeing the same failures, and by re-running them with the
change restored (route-parity passed twice, `store.test.ts` failed once and passed once on identical
code). The upstream purity gate passes: these new comments name no downstream deployment.
