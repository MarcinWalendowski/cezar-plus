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

Steps 1 to 4 are **executed and green**. Files: `packages/cezar/src/reports-triage.test.ts` (9),
`packages/cezar/src/server/reports-api.test.ts` (21), `packages/cezar/src/server/contract-parity.reports.test.ts`
(compile-time, all six responses, both directions), `packages/web/src/routes/reports/reports.test.tsx` (14).

Each of the three claims most worth doubting was **mutation-tested** rather than trusted, because a
guard that cannot fail is the failure mode this suite is most exposed to:

| Mutation | Expected | Observed |
| --- | --- | --- |
| `withTriageLease` bypasses the lease | the three lease tests fail | 3 failed |
| `mintOrReuseTodo` stops reusing the existing todo | the two idempotency tests fail | 2 failed |
| `isReport` returns `true` for every document | the untagged negative control fails | 1 failed |
| counts computed after the `status` filter | a badge test fails | **0 failed — the assertion was vacuous** |
| cockpit badges count the rendered page | a badge test fails | 1 failed (after the fix below) |
| dismiss confirm drops its `reason.trim()` guard | the required-reason test fails | 1 failed |

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

### Still QA Needed

Steps 5 to 8 (the production runtime pass) have **not** run — this is committed and gates-green, not
Done. Step 8 in particular is the only one that proves arrival → inbox unattended, and it needs a
real `feedback:` message to a production bot plus one drain-timer tick.
