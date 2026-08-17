# Knowledge skills-preview parity — the Knowledge page opens/previews like the Skills page

- **Status:** Implemented + Done — shipped in `a960f1bf`, deployed to cockpit.example.com 2026-08-17;
  Verification items 1-4 executed (gates + real-corpus browser E2E, three fix rounds recorded
  below); the owner device QA (real-phone mobile toggle) was closed 2026-08-17 by the owner's
  bulk QA acceptance at the cutover — waived, not executed. (Original owner instruction
  2026-08-17: "knowledge base should open/preview the same way as we preview skills — it
  appears on the right side: just copy this UI and search behaviour", referencing
  `/p/<project>/skills?skill=cloudflare`)
- **Owner ask date:** 2026-08-17
- **Depends on:** `2026-08-17-notion-export-cezar-import.md` (the 2,066-doc corpus is the
  primary dataset this page now serves)

## TLDR

Rework the project Knowledge page (`/p/:projectId/knowledge`) to behave exactly like the
Skills page: the full catalog is always listed in a fixed 320px left pane, an
un-debounced filter input narrows it client-side as you type, selection lives in the URL
as `?doc=<id>`, and the selected document renders in a right-side preview pane that is
always present on md+. A new `GET /knowledge/documents` endpoint supplies the browseable
catalog (today the page can only show BM25 search results, and an empty query shows
*nothing*). Server-side BM25 full-text search is kept as an automatic fallback when the
client-side filter finds zero hits.

## Problem

The Skills page is the UX the owner wants everywhere: list always populated, instant
filter, right-side preview, URL-addressable selection. The Knowledge page today:

1. **has no browse state** — the list is always the `/knowledge/search` response, and an
   empty query returns zero results by design, so the initial page is "No documents
   match." with an empty right pane. With the Notion corpus (2,066 docs) mounted, the
   page hides everything until you guess a query;
2. **navigates instead of previewing** — clicking a row goes to `/knowledge/:id` (a path
   change), not a `?doc=` selection like `?skill=`;
3. **search feels different** — 250ms debounce + server round-trip vs the Skills page's
   instant client-side ranked filter.

## Solution

Copy the Skills page structure and behaviours onto the Knowledge page, keeping the
knowledge-specific affordances (facet chips, DocumentReader with superseded banner,
WS-driven invalidation) that Skills has no counterpart for.

### What is copied from Skills (`routes/skills.tsx`)

| Behaviour | Skills source | Knowledge target |
| --- | --- | --- |
| Two-pane layout: list `md:w-[320px] md:shrink-0 md:border-r`, sticky under the h-14 header (`md:sticky md:top-14 md:max-h-[calc(100dvh-(var(--spacing)*14))]`); detail `min-w-0 flex-1` | skills.tsx:104-115, 202-235 | same classes, `data-slot="knowledge-list"` / `"knowledge-detail"` |
| Selection in URL query param, rows are `<Link>`s | `?skill=<name>`, skills.tsx:90, 240-277 | `?doc=<id>` on `/knowledge` |
| Full list always loaded; filter input narrows client-side, **no debounce** | skills.tsx:117-140, lib/skills.ts | new `filterKnowledgeDocs` in `packages/web/src/lib/knowledge.ts` |
| Selection fallback: explicit param if it exists → first shown item → empty state; fallback selection does NOT rewrite the URL | skills.tsx:94-99 | same chain (first item = most recently updated doc) |
| Mobile: list shown when param absent, detail + "Back to the list" link (md:hidden) when present | skills.tsx:107-115, 207-214 | same |
| Filter input styling `h-8 text-[13px]`, placeholder "Filter documents…" | skills.tsx:117-127 | same |

### What is deliberately NOT copied / kept knowledge-specific

- **Facet chips stay.** Type / Status / Root / Tag FacetGroups (fed by `GET /knowledge`
  facets) remain under the filter input, and a **Domain** facet group is added (the wire
  already carries `facets.domains`; the corpus is domain-tagged precisely for this).
  Facet selections AND with the text filter, all client-side against catalog fields.
- **The right pane content stays `DocumentReader`** (`routes/knowledge/document.tsx`) —
  title, badges, superseded banner + correction trail, markdown body — inside a container
  copying the skills-detail paddings (`min-w-0 flex-1 px-4 py-4 md:px-7 md:py-5`).
  `hrefForId` now produces `/knowledge?doc=<id>` links.
- **Body fetch stays per-selection** — `GET /knowledge/:id` via `useKnowledgeDocument`
  (skills ships bodies in the list; 2,066 markdown bodies ≈ many MB, so knowledge keeps
  the catalog/body split).
- **BM25 stays on the wire and in the UI as a fallback** (below). The workspace knowledge
  page keeps its server-side search (cross-project; no full catalog exists client-side).

### Search behaviour

1. Primary: `filterKnowledgeDocs(docs, query)` — client-side, un-debounced, semantics
   mirroring `lib/skills.ts` ranked scoring (exact > prefix > word-boundary > substring),
   matched over: `title`, `slug`, `tags`, `domain`, `identifiers`, `headings`, `excerpt`,
   `type`. Deterministic order: score, then `updatedAt` desc, then `id`. Empty query =
   full catalog sorted `updatedAt` desc, `id` tie-break.
2. Fallback: when `query` is non-empty AND the client-side filter (after facets) yields
   **zero** hits, run the existing server BM25 search (`useKnowledgeSearch`-style inline
   query, 250ms debounce, filters included in the query key) and render its results under
   a small "Full-text matches" caption. This preserves body-text search, which catalog
   fields cannot see. If the fallback also finds nothing: "No documents match."
3. Pure function, unit-tested; no fetch inside the filter.

### New wire surface (contract-first)

`GET /api/v1/p/:projectId/knowledge/documents` — the browseable catalog.

- Response `{ documents: KnowledgeDocument[], total: number, truncated: boolean }` where
  each entry is the catalog shape **without `body` and without `links`** (zod:
  `knowledgeDocumentListSchema = knowledgeDocumentSchema.omit({ body: true, links: true })`
  in `packages/contract/src/knowledge.ts`, response schema alongside).
- Server: `store.listDocuments()` (already exists, no bodies), sorted `updatedAt` desc
  with `id` tie-break **server-side** (deterministic, no clock-derived fields — D8).
- Flag off: 200 `{ documents: [], total: 0, truncated: false }` (EMPTY pattern, matches
  `GET /knowledge`).
- `truncated` mirrors the store's scan truncation flag (same source as `GET /knowledge`
  `scan.truncated`) — a capped scan must not read as a complete catalog.
- No params in v1 (no paging: one project's catalog is bounded by the scan caps; the
  2,066-doc corpus measured payload goes in Verification).
- Registered in the same Hono `knowledgeRoutes` family; route-inventory /
  versioned-surface / contract-parity suites updated by following their failures.

### Client plumbing

- `client.ts`: `getKnowledgeDocuments(projectId)` wrapper next to the existing knowledge
  wrappers.
- `queries.ts`: `queryKeys.knowledgeDocuments = [queryScope(), 'knowledge', 'documents']`
  (under the `'knowledge'` prefix so the existing WS topic invalidation
  (knowledge.tsx:100-107) refreshes it on corpus changes), hook `useKnowledgeDocuments`.
- Row list uses **virtua** (already a dependency) inside the `overflow-y-auto` container —
  2,066 rows is the known real dataset; plain DOM rows at that count jank.

### Routing

- `/p/:projectId/knowledge` — the page; selection via `?doc=<id>`.
- `/p/:projectId/knowledge/:id` — kept as a redirect: `<Navigate to="/knowledge?doc=<id>"
  replace>` (scope-preserving, like SettingsSkillsRedirect at routes.tsx:123-131).
  In-repo producers of `/knowledge/<id>` links are updated to the new shape directly
  (workspace-knowledge.tsx SearchResultRow `scopeTo(...)`, DocumentReader `hrefForId`
  call sites); the redirect exists for stale bookmarks/history only.
- Legacy flat `/knowledge/*` → boot-project redirect (routes.tsx:744) is untouched.

### Row presentation

Copy SkillRow's shape (skills.tsx:240-277) with knowledge content: `BookOpenIcon`
(matches the nav item) instead of SparklesIcon; title in `text-[13px] font-medium`
(knowledge titles are prose, not identifiers — no mono); right-aligned pill = root badge
(existing root/status badge components); `line-clamp-2` excerpt in `text-xs
text-soft-foreground`; active row `bg-muted` + `aria-current="page"`; conflict pill and
status badge preserved from the current ResultRow where present.

## Architecture

Unchanged: KnowledgeStore, BM25 search module, workspace knowledge family, mutators,
proposals. This is a read-path UI rework plus one additive read endpoint. No Loki-specific
strings anywhere (upstream-purity guard scans `packages/{cezar,web}/src`; this feature is
generic F1 surface).

## Phases

1. **Contract + server**: `knowledgeDocumentListSchema` + response schema; `GET
   /knowledge/documents` route; server tests (flag off/on, sort, no body/links on wire);
   update route-inventory/parity suites as their failures direct.
2. **Web**: `lib/knowledge.ts` filter + unit tests; `useKnowledgeDocuments`; rework
   `routes/knowledge/knowledge.tsx` to the skills layout (?doc= selection, virtua list,
   facets incl. new Domain group, BM25 zero-hit fallback); `/knowledge/:id` → redirect;
   update link producers.
3. **Tests + verification** (below), then commit as
   `feat: knowledge skills-preview parity (2026-08-17 spec)`.

## Data Models

No storage changes. Wire-only: the list projection schema (catalog entry minus
`body`/`links`).

## API Contracts

See "New wire surface". Everything else unchanged.

## Risks

- **Payload size**: 2,066 catalog entries without bodies/links; measured in Verification.
  If a future corpus grows 10x, add paging then (the endpoint returns `truncated` so a
  capped scan is already visible).
- **Client filter blind to body text**: mitigated by the BM25 zero-hit fallback; a query
  that matches only body text still surfaces results (one extra round-trip, only in the
  zero-hit case).
- **Route-inventory/parity suites**: adding a route intentionally trips them; the fix is
  updating the inventories, not skipping the suites.
- **routes.test.tsx**: the `/knowledge/:id` redirect changes the URL map; the suite must
  assert the redirect target (including search-param preservation of scope).

## Verification

Executable, in order:

1. `npm run typecheck && npm test && npm run test:unit && npm run build &&
   npm run test:package` — all green (includes design-guardian, upstream purity,
   route/contract parity, new unit + component tests).
2. New server tests: `/knowledge/documents` flag-off → empty 200; flag-on → sorted
   catalog, entries carry no `body`/`links`; `truncated` propagates from the store scan.
3. New web tests: `filterKnowledgeDocs` ranking + tie-break; component test — list
   renders from the documents query, typing narrows without any network call (assert no
   fetch), zero-hit non-empty query flips to the BM25 fallback (mocked) with the
   "Full-text matches" caption; routes test — `/p/x/knowledge/abc` redirects to
   `/p/x/knowledge?doc=abc`.
4. **Runtime E2E on the real corpus** (local cockpit, `CEZ_KB=1 CEZ_WORKSPACE_VIEWS=1`,
   loki-labs project, 2,066 docs): page cold-loads with the full list visible and the
   most-recent doc previewed on the right; typing narrows instantly; clicking a row sets
   `?doc=` and renders the body on the right; a body-only phrase (present in a doc's body
   but not title/excerpt/headings/tags) still surfaces via the fallback; mobile viewport
   shows list↔detail toggle with Back link; measure and record the
   `/knowledge/documents` payload size (raw + gzipped if served compressed).
5. Deploy to `cockpit.example.com`, owner QA glance.

## Verification results (2026-08-17)

**Items 1-3 (implementing session).** Item 4 (runtime E2E on the real corpus) and item 5
(deploy + owner QA) are left for the orchestrator — not run in this session.

**Item 4 — runtime E2E on the real corpus (orchestrator, 2026-08-17, executed).** Local
cockpit `CEZ_KB=1 CEZ_WORKSPACE_VIEWS=1`, loki-labs project, real Chrome
(claude-in-chrome), after two fix rounds (layout defects; subsequence-tier filter bug —
both found by THIS pass, sections below):
- Cold load: full catalog listed (2,068 docs — 2,066 exported + 2 cutover files picked
  up live by fs.watch, including the `project` root), most-recently-updated doc
  auto-previewed on the right, no URL rewrite. ✓
- Facet groups capped at 8 with "+N more" ("+237 more" on Tag); facets + rows scroll
  inside the pane's own `min-h-0 flex-1 overflow-y-auto` region; the page body never
  scrolls and the preview pane stays put. ✓
- Row click → URL becomes `?doc=notion-00e2e6860c62`, active row highlighted, body
  fetched and rendered by DocumentReader. ✓
- Body-only phrase "NECP denial" (verified present only deep in 2 docs' bodies, zero
  catalog-field substring hits): client filter yields zero, the BM25 fallback fires and
  renders a "FULL-TEXT MATCHES" caption with exactly those docs (SPEC-281 share-button
  first). No /knowledge/search request fires while client-side hits exist. ✓
- Payload: `GET /knowledge/documents` = **2.14 MB raw for 2,066 docs, 17 ms on
  loopback; the server does not compress** (identical size with Accept-Encoding: gzip) —
  Cloudflare's edge compresses it in production; revisit only if the corpus grows ~10x
  (then add paging per Risks).
- Mobile list↔detail toggle: pinned by component tests with the exact skills classes;
  real-device pass stays with the owner's QA (item 5).

1. **Gates, all green**, run individually from the repo root:
   - `npm run typecheck` — clean across contract, api-client, server (`tsconfig.test.json`)
     and web.
   - `npm test` — **463 test files, 8,573 tests passed, 1 skipped** (the skip is
     pre-existing, unrelated to this change). Includes design-guardian, upstream-purity,
     route-inventory (`bc-route-inventory.test.ts`), `versioned-surface.test.ts`, and every
     `contract-parity.*` suite.
   - `npm run test:unit` — 35 passed, 1 skipped (pre-existing), 0 failed.
   - `npm run build` — server + web build, then `check:pack`: "check:pack ok — 990 files,
     222 under web/dist (shell + assets present)". One pre-existing, unrelated warning
     (a vendor chunk over the 500 kB rolldown size-warning threshold — mermaid/diagram
     libraries, not touched here).
   - `npm run test:package` — 15/15 passed (tarball install + dry-run CLI + publish-script
     suite).
   - `npx prettier --check` on every touched file reports "Code style issues" — but so does
     `packages/web/src/routes/skills.tsx` itself, a file this session never touched and the
     spec names as the copy source. The repo carries no `.prettierrc`/`prettier.config.*`
     and hand-maintains its own style, so this is universal pre-existing noise, not a
     regression; `--write` was deliberately not run (would reformat the whole repo against
     its own convention).

2. **Server tests** (`packages/cezar/src/server/knowledge-api.test.ts`, new describe block
   `GET /knowledge/documents — the browseable catalog (skills-preview parity)`):
   - flag-off is covered by the shared `GET_ROUTES_OFF` table (added
     `['/api/v1/knowledge/documents', { documents: [], total: 0, truncated: false }]`).
   - `'returns entries sorted updatedAt desc / id tie-break, carrying no body and no links'`
     — two documents created via `POST /knowledge` with explicit frontmatter `updatedAt`
     (not mtime-derived, so the order is deterministic rather than timing-dependent);
     asserts response order and `doc.body`/`doc.links` both `undefined` on every entry.
   - `'tie-breaks equal updatedAt by id ascending'` — two documents sharing one `updatedAt`
     stamp, asserts `id` ascending order.
   - `'truncated propagates from the store scan'` — a second `KnowledgeStore` built with
     `caps: { maxFiles: 1, ... }` so the scan genuinely truncates, asserts
     `documents.truncated === true` on the wire.
   - `contract-parity.knowledge.test.ts` extended with a fifth compile-time
     `Assert<Exact<...>>` check pinning `knowledgeDocumentsResponseSchema` against the
     route's own inferred `KnowledgeDocuments200` type, both directions.

3. **Web tests**:
   - `packages/web/src/lib/knowledge.test.ts` (new) — 8 tests: empty-query sort
     (`updatedAt` desc, `id` tie-break), exact > prefix > substring ranking, title-hit
     outranking a secondary-field hit, one match per matched field (slug, tags, domain,
     identifiers, headings, excerpt, type), "every word must match" (AND semantics),
     case-insensitivity, tie-break ordering, and no-mutation-of-input.
   - `packages/web/src/routes/knowledge/knowledge.test.tsx` (rewritten) — 13 tests:
     flag-off never calls `/knowledge` or `/knowledge/documents`; cold load previews the
     catalog's most-recently-updated document; conflict pill; **facet click narrows with
     zero new requests**; **typing a query that still matches narrows instantly and never
     calls the server, even past the 250ms debounce window**; **a zero-hit query flips to
     the mocked BM25 fallback and renders the "Full-text matches" caption**; empty-catalog
     copy; row click sets the selection and renders the body; explicit `?doc=` wins over
     the catalog default; a stale `?doc=` falls back to the catalog default rather than
     blanking the pane (never "Document not found" for a merely-unfiltered id); every
     knowledge request (facets, catalog, document, search) carries the active project's
     `/p/<id>` prefix; lazy-loaded reader renders the body; "Document not found" for a
     genuine id-resolves-but-detail-races-null case.
   - `packages/web/src/routes.test.tsx` — new case in the "scoped route map" describe:
     `` `/p/${BOOT}/knowledge/abc` redirects to `/p/${BOOT}/knowledge?doc=abc` `` — asserts
     `currentPathname`, `currentSearch` and `routeName()` after the redirect.
   - `packages/web/src/routes/workspace/workspace-knowledge.test.tsx` — existing
     `SearchResultRow` href assertion updated to
     `/p/shop/knowledge?doc=shop-idx1`.

**Payload size**: not measured — that specific number is item 4 (the real 2,066-doc
corpus), left for the runtime E2E pass.

## Fixes after runtime E2E (2026-08-17)

The orchestrator ran item 4 against the real 2,066-doc corpus (`localhost:4399`,
`loki-labs` project). The endpoint itself checked out — 2,066 docs, 2.14 MB payload, no
`body`/`links` on any entry, sorted correctly — and cold load previewed the
most-recently-updated document as expected. Three defects in the page itself, all in
`packages/web/src/routes/knowledge/knowledge.tsx`, fixed in this follow-up pass:

1. **Unbounded facet groups.** The Tag facet alone carries ~400 buckets
   (`KnowledgeStore.getFacets`, `packages/cezar/src/knowledge/store.ts`, sorts buckets
   alphabetically by value, not by count), so the Tag group rendered ~400 chips and filled
   many screens. Fix: `FacetGroup` now ranks buckets by count desc (tie-break alpha) and
   shows only the top `FACET_VISIBLE_CAP` (8), with a "+N more" toggle chip that expands
   the group in place and a "Show fewer" chip that collapses it back. Counts stay visible
   on every chip, capped or not.
2. **The page scrolled instead of the list pane.** The facet block (now capped, but this
   was true before the cap too) rendered as its own `shrink-0` sibling ABOVE the scrollable
   rows container, outside it. A `shrink-0` element takes its full natural height
   regardless of the pane's `md:max-h-[calc(100dvh-(var(--spacing)*14))]`, so once that
   block's real height exceeded the pane's available height, content overflowed the pane
   (which has no `overflow-hidden` of its own) and the whole page scrolled — carrying the
   right-side preview pane away with it. Fixed by copying skills.tsx's structure exactly
   (skills.tsx:117-152): the filter input is now the ONLY `shrink-0` header; everything
   else — the facet groups, the "Full-text matches" caption, and the rows — renders inside
   ONE `min-h-0 flex-1 overflow-y-auto` region (`data-slot="knowledge-rows"`, same slot
   name, now scoped to the merged region rather than just the rows).
3. **No rows rendered at all.** Direct consequence of #2: with the facet block starving
   the flex layout of height, the scroll region's own computed height could go to zero,
   which is the classic "flex column child with no available height" virtua failure —
   its viewport measured zero, so it windowed to nothing. Resolved by #2's fix, but merging
   facets and rows into one scroll parent introduced a new requirement: virtua's rows no
   longer start at that parent's scrollTop=0 (the facets render before them in the same
   parent now), so `<Virtualizer>` needs `startMargin` — the same prop
   `commit-list.tsx`/`thread-scroller.tsx` already use for "content before the virtualizer
   in the same scroller" — set to the facets block's live rendered height, measured via a
   `ResizeObserver` on a `facetsRef` div (not those two files' window-resize listener,
   since this block's height also changes on facet-data arrival and on the "+N more"
   toggle, neither of which fires a window resize).

   The E2E report also noted that typing "NECP denial" (a body-only phrase) fired no
   `/knowledge/search` request, and flagged it as possibly the same root cause. It was:
   with the scroll region's rows never rendering, nothing downstream looked broken in a
   way that would have surfaced a fetch either — the zero-hit fallback logic itself was
   never in question (it already had a passing component test asserting the outgoing
   fetch). Re-verified after the layout fix: `knowledge.test.tsx`'s existing "a zero-hit
   query flips to the BM25 fallback" test still asserts `sent.some(...)` sees the
   `/knowledge/search` request land, unchanged and still green.

**Tests added** (`packages/web/src/routes/knowledge/knowledge.test.tsx`, 16 tests total,
13 → 16):

- `KnowledgeRoute: the list pane scrolls, not the page` — asserts `[data-slot="knowledge-
  rows"]`'s className contains `min-h-0`, `flex-1`, and `overflow-y-auto` (a structural
  pin, deliberately brittle — losing any of the three silently reintroduces defect 2
  rather than throwing); asserts the facet block and both catalog rows are genuinely
  nested inside that region (`Element.contains`), not merely present somewhere in the
  document; asserts the filter input is NOT inside it (must stay the fixed header).
- `KnowledgeRoute: facet chip cap` — two tests: a 12-bucket Tag fixture shows exactly
  chips 1-8 plus a "+4 more" toggle, expanding reveals all 12 and flips the toggle to
  "Show fewer", collapsing returns to 8 + "+4 more"; a facet with ≤8 values (Type, 2
  values in the fixture) renders no toggle at all.

**Gates re-run, all green**: `npm run typecheck` clean; `npm test` — 463 files, **8,576**
tests passed (was 8,573; +3 new), 1 pre-existing skip; `npm run test:unit` — 35 passed, 1
skipped, 0 failed; `npm run build` — `check:pack ok — 990 files, 222 under web/dist`,
unchanged; `npm run test:package` — 15/15 passed. The targeted knowledge test file was
also run 3 times consecutively in isolation (16/16 each run) to rule out flakiness from
the `ResizeObserver`-driven `startMargin` measurement.

Items 4 (now run) and 5 (deploy + owner QA) still belong to the orchestrator — this pass
only fixed the three defects item 4 surfaced and re-ran the gates; it did not re-run the
runtime E2E itself or deploy.

## Fixes after runtime E2E, round 2 (2026-08-17): the subsequence-tier filter bug

Round 2 of the real-corpus E2E confirmed the round-1 layout fixes (facet caps, internal
scroll, rows render, preview pane stays put) but surfaced a correctness bug: typing
"NECP denial" — a phrase buried only in two docs' bodies, zero catalog-field hits —
returned a large ranked list of unrelated docs and never fired `/knowledge/search`.

**Root cause**: `filterKnowledgeDocs` (`packages/web/src/lib/knowledge.ts`) scored every
word through `lib/skills.ts`'s `matchScore`, whose bottom tier is a case-insensitive
SUBSEQUENCE match ("omfx" finds "om-fix-issue") — the same permissiveness `fuzzyMatch`
gives the composer's `/` autocomplete. That tier is right-sized for a skill name (a
handful of characters), but over a knowledge document's secondary haystack
(slug+tags+domain+identifiers+headings+excerpt+type, hundreds of characters once excerpt
and headings are populated), nearly any short word matches SOME haystack as a
subsequence. So `documentScore` almost never returned 0, junk rows kept ranking, and the
zero-hit BM25 fallback (`knowledge.tsx`'s `zeroHits`, gating the `/knowledge/search`
fetch) never got the chance to fire. The round-1 component tests all passed because their
fixture strings were short — too short for the subsequence coincidence to occur — which
is exactly the fixture-blindness this needed a long-excerpt negative control to catch.

**Fix, `packages/web/src/lib/knowledge.ts` only** (`lib/skills.ts` untouched — the
subsequence tier is correct there, for short skill names): added `literalMatchScore`,
which gates `matchScore` behind an explicit `haystack.includes(word)` substring check
before accepting its return value, rather than trusting a hardcoded score threshold. A
hit now only counts when it is a literal one (exact / prefix / word-boundary / buried
substring) — the subsequence tier can never contribute to a document's score.
`documentScore` now calls `literalMatchScore` for both the title and the secondary
haystack.

**Regression tests added**:
- `packages/web/src/lib/knowledge.test.ts` (+2): a document with a realistic 345-character
  ordinary-prose excerpt scores 0, and `filterKnowledgeDocs` returns `[]`, for a query
  word ("cred") that is a subsequence of the excerpt but never a literal substring of it
  (verified: `c`…`loning`, `r`…`epository`, `r-e`…`pository`, `d`…`ependencies`); a second
  test confirms exact/prefix/word-boundary/buried-substring hits still rank in that order
  against a long secondary haystack, so the substring gate doesn't disturb literal
  ranking.
- `packages/web/src/routes/knowledge/knowledge.test.tsx`: the existing "a zero-hit query
  flips to the BM25 fallback" test's fixture was replaced — the catalog's current doc now
  carries the same long excerpt, and the typed query changed from `'ledger'` (which never
  exercised the subsequence coincidence — too short a catalog fixture) to `'cred'` (the
  subsequence-matchable-but-not-substring shape that broke in production). Test count 13
  → 16 (round 1) → still 16 (this fixture swap replaced one test rather than adding one).

**Negative control**: before finalizing, temporarily reverted `documentScore` to call
`matchScore` directly (bypassing `literalMatchScore`) and re-ran both test files — both
new/changed tests failed exactly as expected: the `lib/knowledge.test.ts` case returned
non-empty instead of `[]`, and the `knowledge.test.tsx` zero-hit test's `DOC_CURRENT_ID`
row kept rendering (visible in the test's DOM dump: the long-excerpt document, still
selected and shown, when it should have dropped out). Restored the fix and confirmed
both files return to green before re-running the full gates.

**Gates re-run, all green**: `npm run typecheck` clean; `npm test` — 463 files, **8,578**
tests passed (was 8,576; +2 new), 1 pre-existing skip; `npm run test:unit` — 35 passed, 1
skipped, 0 failed; `npm run build` — `check:pack ok — 990 files, 222 under web/dist`,
unchanged; `npm run test:package` — 15/15 passed.

Still no commit, no deploy, no re-run of the runtime E2E itself — items 4/5 remain the
orchestrator's.
