# Notion export → cezar import

**Status:** Implemented (2026-08-17, local; runtime E2E executed — results in Verification. QA Needed only for the owner's one-glance cockpit-UI browse of the Knowledge tab; hosted move stays out of scope per Phases)

> **CUTOVER ADDENDUM (2026-08-17, later the same day).** The owner declared the
> Notion cutover ("let's switch to cezar now, don't push to notion anymore"), which
> supersedes every "Notion stays the source of truth until cutover" statement in this
> spec, including in the TLDR below. Since then: the corpus IS the record; `/cezar-sync`
> writes corpus-only (no Notion leg); new items use `local:` identifiers; the exporter
> is retired except `--only raw-input` (a full run would resurrect stale Notion state
> over the living corpus); `/notion-sync` is retired except the Raw Input drain; and
> user reports bypass Notion entirely via `chat/.ai/specs/SPEC-526-2026-08-17-user-reports-to-cezar.md`
> (worker stages to BOT_KV, `tools/reports-drain/drain.mjs` writes
> `notion-export/reports/`). The PLAN Phase 3 precondition (owner decision on
> shared-instance auth) was satisfied by the 2026-08-16 prod deploy
> (`CEZ_AUTH=oidc` behind Cloudflare Access). The corpus was also deployed to the
> production host (`/var/lib/cezar/loki-labs/notion-export/`, served at
> cockpit.example.com) the same day.
**Owner:** Marcin Walendowski
**Program:** central hub (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` outranks this spec on any conflict)
**Related:** `2026-08-06-knowledge-base-mounts-search.md` (F1), `2026-08-06-external-source-connectors-notion.md` (F2), `2026-08-14-knowledge-domains-and-changelog.md`, `2026-08-06-ops-board-notion-cutover.md` (F5, proposed), `2026-08-10-global-tasks-and-project-tags.md`

## TLDR

Export the whole Loki Labs Notion workspace — ✅ Tasks (626 rows, with status and comments), 📝 Changelog (797), 🚩 Reports (193), 🎙 Raw Input (33), and "Loki — Knowledge" (main page + 85 child notes) — into a directory of F1-conformant markdown at `~/loki-labs/notion-export/`, register that directory as a read-only knowledge mount on the `loki-labs` cezar project, and verify locally that cezar's knowledge base serves it: searchable, faceted by product tag, with the changelog projection carrying Notion's own dates and every knowledge document tagged with the product(s) it belongs to. A new workspace skill, `/cezar-sync`, mirrors `/notion-sync`'s shape but reads knowledge from the cezar KB first and writes every session's status/knowledge/changelog updates back into the cezar corpus. Notion stays the source of truth until the owner declares cutover (PLAN Phase 3 precondition); cezar becomes a full, continuously-synced working replica today.

**cezar code changes: none.** Everything lands as files, config, and a workspace skill. That is deliberate — see Architecture.

## Problem

The owner's goal (recorded 2026-08-06) is cezar as the central point for everything instead of Notion. The knowledge base (F1), domains + changelog projection, and the Notion source connector (F2) are implemented, but the actual corpus still lives only in Notion. There is no bulk export of it anywhere, the ops-board cutover spec (F5) is proposed-not-started and explicitly demands an immutable phase-0 export with `notionId` provenance before any ticket migration, and every coding session still runs knowledge-first against Notion via `/notion-sync`. Meanwhile tasks in cezar have no first-class tracker home (todos carry no status, no comments, no priority — verified 2026-08-17 against `contract/src/skills.ts` and the todos routes), so a "just import the tasks into todos" plan is unrepresentable today.

## Solution

Three legs, all local:

1. **Export** (`~/loki-labs/tools/notion-export/export.mjs`, workspace root repo, zero-dependency Node 22): pulls the four databases and the Knowledge page tree via the Notion REST API using the existing SPEC-111 integration token (`op://Vault/Chat Prod/Chatbots/NOTION_API_TOKEN` — verified 2026-08-17: 200 on all four DBs and the Knowledge page). Emits one markdown file per object with frontmatter cezar's knowledge parser (`knowledge/parse.ts`) indexes natively, plus a `manifest.json` keyed on Notion page id + `last_edited_time` so re-runs are incremental. Comments are the one thing the token cannot read (integration lacks the capability; API answers 403) — they are swept in-session through the Notion MCP connector over all non-Done task rows and merged into the task files.
2. **Curate**: an LLM pass assigns `domain` + product `tags` to every knowledge document (the exporter does not guess), and synthesizes one `domains/<product>.md` index doc per product — the "most up to date domain knowledge about each part of the project", built from the tagged corpus.
3. **Import + sync**: `/Users/mw/loki-labs/.ai/cezar/config.json` registers `notion-export` as a read-only knowledge mount on the `loki-labs` project (`knowledge.mounts`, F1's sanctioned path for content that is already files — PLAN D3). A local `cezar serve` with `CEZ_KB=1` indexes it. The new `/cezar-sync` skill makes every future session pull knowledge from this corpus and push its status/changelog/knowledge updates into it as file edits.

### Why not the shipped F2 Notion connector for this corpus

The connector stays the right tool for *continuous mirroring* of raw Notion content (meeting notes later), and enabling it is future work. It is the wrong tool for this corpus, for four reasons: (a) it mirrors raw shape — hash filenames, properties flattened into a `properties` map — with no curation, so it cannot produce status/product tags, `changeType` mapping, or the H2-split Knowledge entries the filtering requirement needs; (b) its comment sweep needs the same integration capability that 403s today; (c) its cold backfill at 1,700-object scale is untested and the mirror dir (`.ai/cezar/sources/`) is sweep-owned — hand-written files there get quarantined as conflicts, so a curated export must not land in it; (d) F5 mandates an immutable, provenance-keyed phase-0 export for the eventual ticket migration, which is exactly this exporter's output and not the connector's. Recorded so the next session does not re-derive it.

### Why tasks land as knowledge documents, not todos or runs

Todos have no status field, no comments, no priority, a closed `origin` enum (`agent|composer` — `User report` is rejected with a 400 and a hand-written value is silently skipped on read), no PATCH route and no stable external key. Runs are live agent executions — you cannot create one in `Blocked`. F5's `ticket` entity is the eventual home and its spec is not started. Knowledge documents carry everything today (status as tags, comments in the body, provenance in `identifiers`), are searchable and faceted, and the `notion:` identifier keys make the future ticket import a mechanical read of this corpus. When F5 lands, its phase-0 export is already on disk.

## Architecture

```
Notion (source of truth until owner cutover)
  │  REST API, SPEC-111 token (read: 4 DBs + Knowledge tree; comments 403)
  ▼
tools/notion-export/export.mjs  ──────────────┐ MCP comment sweep (in-session,
  │  one .md per object + manifest.json       │ non-Done task rows) merges
  ▼                                           ▼ "## Comments" sections
~/loki-labs/notion-export/          ◄── curation pass (LLM): domain/tags + domains/<product>.md
  │  registered read-only mount ("notion") on the loki-labs project
  ▼
cezar KB (CEZ_KB=1) — search, facets, domains, changelog projection
  ▲
  │ file edits (boardStatus, tags, new changelog/knowledge files)
/cezar-sync skill — every session: pull knowledge from here, push updates here
  └─ transitional: mirrors the same updates to Notion (best-effort) until owner cutover
```

- **No cezar code changes.** The fork is a released npm package with protected surfaces; the "upstream purity" guard forbids `loki|lokimessages|imsg` under `packages/{cezar,web}/src` even after the 2026-08-16 rename. Everything here is corpus + config + a workspace-repo tool and skill — cezar's gates never run.
- **Export root placement** (`~/loki-labs/notion-export/`): inside the `loki-labs` project root, so the mount survives a future hosted move (hosted mode refuses mounts outside the repo root). Untracked by construction — the workspace root repo's gitignore is deny-all with an allowlist, and this dir is never allowlisted, which is what PLAN D9 requires: report bodies carry phone numbers, chat ids and handles, and must never reach a git remote.
- **Exporter placement** (`~/loki-labs/tools/notion-export/`): the workspace root repo gets `!tools` in its gitignore allowlist so the *code* is versioned (local-only repo, no remote). Not in `chat/` (not a product concern), not in cezar (released package, purity guard, D7 no-new-deps).
- **Frontmatter contract** (what makes the corpus "easy to import" — F1 parses all of this today): `title`, `type: note|reference`, `domain` (product axis, the 2026-08-14 spec's free-form field), `tags` (faceted; `status/<slug>`, `priority/<slug>`, `origin/<slug>`, product names, `notion-task|notion-changelog|notion-report|notion-raw-input|notion-knowledge`), `identifiers: ["notion:<uuid>"]` (F5's provenance key), `updatedAt` (Notion `last_edited_time`; for changelog rows the row's own Date — which is what the changelog projection sorts by), `changeType: Added|Changed|Fixed|Removed` (exact case — parse drops unknown values silently). Board status additionally sits in a `boardStatus:` key the parser ignores but the file preserves; the KB's own `status:` field is deliberately **not** set (its normalizer maps free text into `current|superseded|draft` and would mangle board semantics).
- **Authority during transition:** Notion remains the record (SPEC-111 report worker, The Loop, and owner comments all still write there; PLAN Phase 3's preconditions — the `report_issue` dual-write and the shared-instance auth decision — are owner calls not made here). `/cezar-sync` therefore writes cezar first and mirrors to Notion best-effort; `/notion-sync` continues to exist. The cutover that retires the Notion leg is a one-line skill edit on the owner's word.

## Phases

| # | Phase | Deliverable |
|---|---|---|
| P1 | Exporter + full export | `tools/notion-export/export.mjs`, populated `notion-export/`, `manifest.json` with counts matching SQL COUNTs |
| P2 | Curation | every knowledge doc carries `domain` + product tags; 8 `domains/<product>.md` index docs (+ process-area domains where warranted) |
| P3 | Comment sweep | MCP `notion-get-comments` over all non-Done task rows, merged as `## Comments`; count reported honestly even if 0 |
| P4 | Mount + local E2E | mount registered, `cezar serve` with `CEZ_KB=1 CEZ_WORKSPACE_VIEWS=1`, Verification executed |
| P5 | Skill + memory | `/Users/mw/loki-labs/.claude/skills/cezar-sync/SKILL.md` + auto-memory entry |
| P6 | Record | Notion Tasks row (Project = Cezar), Changelog entry (Area = Cezar), Knowledge entry; commits (root repo local-only; cezar spec commit → `origin` only, never `upstream`) |

**Out of scope (named so they are decisions, not omissions):** hosted push to cockpit.example.com (file-transfer problem — backup/restore or rsync over the tunnel — after the owner's auth/cutover word; hosted API has cookie-only auth, no machine credential); F5 ticket-entity import; enabling the F2 connector (needs the comments capability toggled on the integration and a connection config; the export makes both later steps cheaper, not harder); retiring `/notion-sync`.

## Data Models

Task file — `tasks/<id8>-<slug>.md`. `id8` = first 8 hex of the undashed page uuid, **extended to 12 (then the full uuid) on a within-run collision**: this workspace's Notion uuids are time-ordered, so same-era pages share their first 8 hex, and the first full export proved it — two duplicate-titled row pairs collided into one filename each, silently dropping a row (caught 2026-08-17). `--verify` now asserts distinct manifest paths == object count — the check whose absence let "manifest count == SQL count" pass (both honestly 626) while a file was missing.

```markdown
---
title: Fix the onboarding card locale fallback
type: note
domain: beside
tags: [notion-task, beside, status/qa-needed, priority/high, origin/user-report]
identifiers: ["notion:3beb9863-7981-8131-b5b8-ca7d5830fc72"]
boardStatus: QA Needed
priority: High
origin: User report
url: https://app.notion.com/3beb986379818131b5b8ca7d5830fc72
createdAt: 2026-08-10T09:14:00.000Z
updatedAt: 2026-08-16T18:02:00.000Z
---
## Context
…row body verbatim (Context / What to do / Acceptance criteria)…

## Comments
- **Owner, 2026-08-12:** …   (section omitted when none)
```

The `## Comments` section is written by the MCP sweep, not the exporter (the token's 403), so the exporter **preserves a trailing `## Comments` section across rewrites** the same way it preserves curated tags — otherwise the first incremental re-run after a row edit would silently clobber the merged comments.

Changelog file — `changelog/<YYYY-MM-DD>-<slug>--<id8>.md`: same shape plus `changeType:` and `updatedAt` = the row's Date start; `domain` from Area (products lowercased; `System→system`, `Tasks→tasks`, `Knowledge→knowledge`, `Raw Input→raw-input`; Grocey entries arrive as Area `Alfredo` per the standing workaround and keep it). One file per entry, mirroring the KB's own one-file-per-entry convention.

Report file — `reports/<id8>-<slug>.md`: `tags: [notion-report, <product>, status/new|processed]`. **PII: stays in the untracked export root, never adopted into a committable knowledge root, never pasted into specs/tasks elsewhere.**

Knowledge — `knowledge/sections/<NNN>-<slug>.md` (main page split on H2, `NNN` preserving page order) and `knowledge/notes/<slug>--<id8>.md` (child pages); `type: note` (`reference` where the section is evergreen reference); curation adds `domain` + tags, `domain: workspace` for cross-cutting entries. Domain index docs — `domains/<product>.md`, `type: reference`, slug equal to the domain id so the KB's best-effort index-doc lookup lands on it; body synthesized from the tagged corpus and marked `> Synthesized from the Notion export of <date>; sources listed below.`

`manifest.json`: `{ exportedAt, notionVersion, databases: {tasks|changelog|reports|rawInput: {id, count}}, knowledgePageId, objects: { "<uuid>": { path, lastEditedTime, hash } } }`. Re-run: unchanged `last_edited_time` → skip; changed → rewrite (curated `domain`/topic tags are preserved when the file carries `curated: true`; structural `status/*`-class tags always regenerate); gone from Notion → move file to `deleted/` (that basename is in the KB scanner's exclusion list, so a tombstoned row leaves the index — `_removed/` would have stayed searchable, the exact D18 failure) and drop it from the manifest, never silently.

## API Contracts

Consumed, Notion REST (version `2022-06-28`): `POST /v1/databases/:id/query` (pagination 100), `GET /v1/pages/:id`, `GET /v1/blocks/:id/children` (recursive, paginated), ~3 rps with backoff on 429. Block converter covers the types in use: paragraph, heading_1/2/3, bulleted/numbered/to_do list items, code, quote, callout, divider, toggle, table/table_row, child_page (as link), bookmark/link_preview, image (as link — assets are not downloaded in P1). Unknown block types degrade to a `<!-- unsupported: <type> -->` marker plus plain-text extraction, counted in the manifest as `lossy` — never dropped silently.

Consumed, cezar (verification only, no new routes): `GET /api/v1/p/loki-labs/knowledge`, `/knowledge/search`, `/knowledge/:id`, `GET /api/v1/workspace/knowledge/changelog`, `GET /api/v1/workspace/knowledge/domains`. Flag-off behaviour is F1's own (GET empty-200 / mutators 409).

Produced: the frontmatter contract above — this **is** the import contract, and the fields are exactly what `knowledge/parse.ts` reads today plus inert extras.

## Risks

1. **Comment capability.** The SPEC-111 integration cannot read comments (403). Mitigated: MCP sweep in-session for non-Done rows now (executed 2026-08-17: 262 task rows + 2 report rows swept, **12 rows with comments** — a 6-row spot-sample earlier the same day had found zero, which is why the sweep covers everything rather than trusting a sample); flagged as an owner checkbox ("Read comments" on the integration) after which the script covers all rows including Done history. Until then, Done-row comment history is not exported — stated, not hidden.
2. **LLM curation can mistag.** Tags are visible facets, so a wrong tag is findable; the pass records `domain: workspace` when unsure rather than guessing a product; domain index docs cite their sources.
3. **Dual-write drift during transition.** Notion and the export corpus can diverge between syncs. Bounded: re-running the exporter is incremental and cheap; `/cezar-sync` treats Notion as authority on conflict until cutover.
4. **KB caps** (1 MiB/file, 20k files, 64 MiB total): ~1,750 files, largest single section well under the cap after H2 split; the exporter warns if any emitted file exceeds 900 KiB. `scan.truncated` is checked in verification rather than assumed empty.
5. **Registry slug instability** (`loki-labs` is machine-local): the mount is registered per-machine config, not by slug in file content; nothing in the corpus embeds the slug.
6. **`.ai/cezar` concurrency** (RunStore rewrite hazard, boot-dedupe fixed 2026-08-16): this work only adds a `knowledge.mounts` key to `config.json` and never touches `runs.json`.

## Verification

Executed 2026-08-17; every item below ran. Results:

1. Completeness — PASS after one real defect: the first full run wrote 626+798+193+33+404 objects into **two fewer files** (the id8 collisions above); the incremental re-run with the fix recovered both rows (2 tasks + 2 changelog rewritten, all else skipped) and `--verify` now pins path coverage (2,062 files / 2,054 manifest objects + 8 synthesized domain docs, 0 violations).
2. Fidelity — 10/10 FAITHFUL (stratified: 4 tasks across all statuses, 2 changelog, 2 reports, 2 knowledge notes) vs live Notion, including comment-by-comment verification on 2 comment-carrying tasks (3/3 and 8/8, exact timestamps, resolved author names) and checkbox states. Cosmetic-only diffs: heading levels one deeper by design; minute-truncated timestamps; body images are time-limited signed S3 URLs (will expire; assets not downloaded in P1).
3. Parse-back — 0 violations; 6 diverse files additionally fed through cezar's own compiled `dist/knowledge/parse.js` with zero warnings.
4. Import E2E — server on :4399, `CEZ_KB=1 CEZ_WORKSPACE_VIEWS=1`: (a) 2,062 docs, mount `notion` indexed, 0 id collisions, scan not truncated; (b) all product/status/origin facets present (`notion-task` 626, `status/*` summing to the board, `domain-index` 8), `SPEC-282` search returns the actor-retirement decision first; (c) changelog projection carries Notion's own dates and changeTypes; (d) domains lists all 8 products with counts — **index-doc resolution 5/8** (beside/loki/predicts unresolved: the lookup is a bounded BM25 search, `INDEX_DOC_SEARCH_LIMIT = 20`, and those product names flood the corpus — cezar's own docblock names `findBySlug` as the missing fix; filed as a follow-up task); (e) negative control PROVEN: the lowercase-`changeType` fixture was indexed with `changeType: null` (flag stripped) and stayed out of the projection, then removed.
5. Comment sweep — 262 task + 2 report rows swept, 12 rows with comments, all merged; the exporter preserves `## Comments` across rewrites (validated with a forced-rewrite fixture).
6. Skill mechanics — pull: corpus search answers directly; push: a `boardStatus`/tag flip appeared in live facets in ~4s and reverted cleanly; a changelog-file write appeared in the projection. **Caveat, filed as follow-up:** the workspace knowledge routes served a frozen store snapshot until restart — `resolveStore`'s live-context peek missed for the boot project and the standalone-store cache has no invalidation — so cross-project views can lag file writes; per-project routes are live.
7. PII gate — `git status --porcelain` clean of `notion-export/` before and after; reports exist only under the untracked root.

Original plan (kept for the record):

1. **Export completeness:** manifest counts equal the live SQL COUNTs at export time (2026-08-17 baseline: Tasks 626, Changelog 797, Reports 193, Raw Input 33, Knowledge child notes 85 + main-page sections). Any `lossy` markers enumerated.
2. **Fidelity spot-check (n=10, stratified):** 4 tasks (one per non-Done status + one Done), 2 changelog rows, 2 reports, 2 knowledge notes — file content vs the live Notion page: title, status, project, date, body sections present and correctly converted.
3. **Frontmatter parse-back:** exporter `--verify` re-parses every emitted file with the same tolerant rules F1 uses (changeType exact-case, tags array, ISO dates); zero parse warnings allowed.
4. **Import E2E (runtime, local):** `CEZ_KB=1 CEZ_WORKSPACE_VIEWS=1 cezar serve` on the `loki-labs` project with the mount registered →
   a. `GET /knowledge` counts include the export; `scan.truncated` empty; mount `indexed: true`.
   b. Facets contain the product tags and `status/*` tags; `search?q=SPEC-282` returns the knowledge section that records the product/agent split.
   c. `GET /workspace/knowledge/changelog` returns entries whose dates are Notion's row dates (not export mtime) with correct `changeType`.
   d. `GET /workspace/knowledge/domains` lists the 8 products; each resolves its `domains/<product>.md` index doc.
   e. Negative control: a deliberately lowercase `changeType: fixed` fixture in a scratch dir is **not** listed as a changelog entry (proves the case rule is load-bearing, then the fixture is deleted).
5. **Comment sweep honesty:** the number of rows swept and comments found is reported; zero is reported as zero.
6. **Skill dry-run:** `/cezar-sync` pull answers a knowledge question from the corpus without touching Notion; push writes one status flip + one changelog file and a re-query shows both (fs.watch reindex); the Notion mirror leg is then exercised once.
7. **PII gate:** `git -C ~/loki-labs status --porcelain` shows nothing from `notion-export/` before and after; `reports/` files exist only under the untracked root.

## Addendum 2026-08-17 (evening) — open tasks migrated onto the Tasks board; QA Needed bulk-closed

The corpus import above put every task (all statuses, id parity 628/628 at the time of this
addendum) into `tasks/*.md` — but the cockpit's Tasks board never reads the KB: it renders
`GET /api/v1/workspace/todos`, i.e. each registered project's `.ai/cezar/todos.json` inbox
(`workspace/todo-index.ts`, `global-tasks.tsx`). So post-cutover the board showed zero open
tasks and the migration looked partial. On the owner's instruction ("mark all tasks QA Needed
as Done and then migrate all tasks to cezar"), two data moves — no cezar code changed:

1. **Corpus status flip:** all 174 QA Needed task files → `boardStatus: "Done"` +
   `status/done` tag + a dated Status note recording that the pending device/QA passes were
   closed by the owner's bulk acceptance, not by recorded test runs. Notion not written
   (read-only archive; its Status column now intentionally lags).
2. **Inbox migration** (v1 — **superseded same evening by
   `2026-08-17-filed-tasks-table-statuses.md`**, whose v2 migration put ALL 631 tasks on the
   board with real `status`/`priority`/`archivedAt` fields, replacing the prefix encoding
   below): the 92 open tasks (49 Todo / 27 In Progress / 16 Blocked) became
   todo entries routed by product → repo: 83 → `chat`, 8 → `cezar`, 1 → `aside`. Mapping:
   `summary` = `[status] title` (prefix only for non-Todo — todos carry no status field),
   `context` = provenance line (status, priority, product, corpus doc path, Notion URL) +
   the task's Context section, `whatToDo` = What-to-do section (whole body as fallback),
   `acceptanceCriteria` = parsed bullets (≤20 × ≤500 chars; overflow retained in
   `whatToDo`), `origin: "composer"`. Entry ids minted once and written to BOTH cockpits
   (local `~/loki-labs`, prod `/var/lib/cezar/loki-labs`) under the server's `todos.lock`
   lease; payload pre-validated through the real `readTodos()` (92/92 accepted).

Verified on cockpit.example.com: Tasks board "Filed — not started yet · 92" stamped per
project; the KB fs.watch re-indexed the rsynced flips with no restart (a flipped doc renders
`status/done` + its Status note). Doctrine recorded in the corpus knowledge note
"Open tasks live in the cezar todo inbox; corpus tasks/ is the archive of record".
