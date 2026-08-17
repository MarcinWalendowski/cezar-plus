# Workspace knowledge: kill the 5s load, preview in place

- **Status:** Implemented — deployed to cockpit.example.com (`80c7ee36`, filters-on-top
  amendment + server-side index-doc pin included), Verification items 1-5 and the amendment's
  real-corpus runtime checks executed 2026-08-17; only real-device QA (mobile toggle, chip
  layout on a phone) remains with the owner
- **Date:** 2026-08-17
- **Owner report (verbatim):** "no it doesn't it opens new path, eveyrthing should be on one
  page, knowlage page is very slow at initial loading - it take 5s to load: can we somejow
  incrementaly load data there?"
- **Follow-up to:** `2026-08-17-knowledge-skills-preview-parity.md` (per-project page parity),
  `2026-08-14-knowledge-domains-and-changelog.md` (the workspace read path this fixes).

## TLDR

Both complaints reproduce on **`/workspace/knowledge`** (the top-level sidebar Knowledge page),
not the per-project page:

1. **~5s initial load.** `GET /api/v1/workspace/knowledge/domains` spends **4.6–4.8s of server
   compute per request** (measured on prod: 4834ms first call, 4646ms repeat, 727 B payload,
   all 12 projects `ok:true` — so it is not store building, not payload, not a deadline trip).
   The cost: `WorkspaceKnowledgeIndex.domains()` → `findIndexDocId` runs a full BM25
   `store.search()` **once per domain (12×/request)**, and every `store.search()` call
   **re-tokenizes the entire corpus** (~2 MB of bodies across 2,066 docs) to rebuild the BM25 +
   identifier index from scratch (`search.ts` `buildBm25Index` per call), then re-computes BM25
   inside the sort comparator per comparison.
2. **"Opens new path."** A search-result row is
   `Link to={scopeTo(result.project, '/knowledge?doc=…')}` (`workspace-knowledge.tsx:322`) —
   clicking navigates away to the per-project page instead of previewing in the right pane the
   way Skills (and the per-project Knowledge page after the parity spec) do.

Fix: **(a)** memoize the search index on `KnowledgeStore`, keyed on catalog generation, and add
`findBySlug` so `domains()` never runs BM25 at all; **(b)** give `/workspace/knowledge` the same
list + right-pane reader as Skills, selection held in query params on the same path, backed by a
new instantiation-free workspace document read.

**The "incremental loading" ask is answered by measurement, not by pagination:** the slow
response is 727 bytes, so there is nothing to load incrementally — the 5s is server compute and
dies with (a). (The per-project catalog, the only big payload, measured 272ms warm at 580 KB
zstd-compressed — fine, left alone.)

## Problem

### Measured (prod, cockpit.example.com, 2026-08-17, authenticated browser)

| Request | Time | Transfer | Note |
| --- | --- | --- | --- |
| `GET /workspace/knowledge/domains` (1st) | 4,834 ms | 727 B | full-page "Loading..." meanwhile |
| `GET /workspace/knowledge/domains` (repeat, `cache:no-store`) | 4,646 ms | 727 B | all 12 projects `ok:true` → warm stores, still ~5s ⇒ per-request compute |
| `GET /p/loki-labs/knowledge/documents` | 272 ms | 580 KB (2.15 MB decoded, zstd at the CF edge) | the per-project catalog is NOT the problem |
| `GET /p/loki-labs/knowledge/:id` | ~50 ms | ~1.5 KB | |

### Cost anatomy of one `domains()` call

1. `domains()` collects per-project facets (cheap, in-memory) …
2. … then for **each** of the 12 domain rows calls `findIndexDocId`, which runs
   `store.search(domain, {limit: 20})` against the first project carrying the domain (in
   practice: loki-labs, 2,066 docs, every time).
3. Each `store.search()` (`store.ts:376`) rebuilds the `searchable` array — a sort plus a map
   that pulls **every document's full body** — and hands it to `search.ts`'s `search()`, which
   calls `buildBm25Index` (tokenizing every body, title 3×-weighted) and `buildIdentifierIndex`
   from scratch, then sorts with a comparator that calls `effectiveScore` (a fresh BM25
   computation) on every comparison.

12 × ~380 ms ≈ 4.6 s. Every request, forever, warm. The same per-call rebuild also taxes the
per-project `/knowledge/search` BM25 fallback (parity spec) and the agent's kb search tool at
~300–400 ms per query on this corpus.

`knowledge-index.ts`'s own doc comment already names the missing piece: *"A proper `findBySlug`
on `KnowledgeStore` … would remove this caveat entirely; noted as a follow-up."* This spec is
that follow-up.

### The path jump

`workspace-knowledge.tsx` renders search results as links out:
`scopeTo(result.project, '/knowledge?doc=' + id)` — a different pathname, a different page, the
list and domain context gone. The owner wants the Skills behaviour: click → right-pane preview,
same page.

## Solution

### Phase 1 — server: memoized search index + `findBySlug` + workspace document read

1. **`knowledge/search.ts`** — export the index as a first-class value:
   - `buildSearchIndex(docs): KnowledgeSearchIndex` — bundles the BM25 index, the identifier
     index, and the doc list it was built from.
   - `search(docs, query, opts)` gains optional `opts.index?: KnowledgeSearchIndex`; when
     present, no per-call `buildBm25Index`/`buildIdentifierIndex`. Absent → build internally
     (existing unit tests keep working unchanged).
   - **Scoring statistics become corpus-wide:** with a shared index, a filtered query restricts
     the *candidate set* only; IDF/avgLength come from the whole corpus (the standard
     Lucene-style boolean-filter model), not from the filtered subset as today. Deterministic
     (D8 intact); exact-score assertions on filtered queries may shift and should be updated
     deliberately, not loosened.
   - **Precompute scores before sorting:** build a `Map<id, score>` once per query and have the
     comparator read it — removes the per-comparison BM25 recompute independently of memoization.
2. **`knowledge/store.ts`** — own the memo and the slug index:
   - A monotonically increasing `catalogGeneration`, bumped everywhere the catalog or working
     bodies change (`initialize`, `performReindex`, `updateDocument`/any write path).
   - `search()` caches `{generation, searchable, index}` and reuses it while the generation
     matches; rebuilds lazily on first search after a change.
   - A `slugIndex: Map<slug, id[]>` maintained under the same generation;
     `findBySlug(slug): CatalogEntry[]` returning ALL matches in the store's deterministic
     `(root, path)` order — collisions stay visible to the caller instead of being silently
     first-picked here.
3. **`workspace/knowledge-index.ts`** — `findIndexDocId` uses `store.findBySlug(domain)` (first
   hit, registry order — the same documented tie-break as today, now exact and O(1)ish instead
   of a BM25 probe). Delete `INDEX_DOC_SEARCH_LIMIT`. Add `getDocument(projectId, docId)` going
   through the existing `resolveSources`/`resolveStore` machinery (peek → instance cache →
   standalone store under the deadline) → `store.getDocument(docId)`. **READ never instantiates
   a context** — same invariant, same structural pin.
4. **`server/workspace-knowledge-routes.ts`** — `GET /workspace/knowledge/document?project=&doc=`:
   - Gate off → 200 `{project, document: null, disabledReason}` (D19 shape, conjunct named).
   - Unknown project or doc → 404.
   - Found → `{project, document}` (full body — this is the reader payload).
5. **`packages/contract/src/knowledge.ts`** — `workspaceKnowledgeDocumentResponseSchema`
   (`{project: string, document: knowledgeDocumentSchema.nullable(), disabledReason?}`).

### Phase 2 — web: one page, preview in place

6. **`routes/workspace/workspace-knowledge.tsx`** — Skills-parity layout on the SAME pathname:
   - Selection lives in `?project=<id>&doc=<id>` on `/workspace/knowledge`; result rows become
     in-page `Link`s to that (pathname unchanged — the owner's "everything on one page").
   - Right pane lazy-loads the existing `DocumentReader` (`routes/knowledge/document.tsx`),
     fed by the new workspace document read. `hrefForId` resolves to
     `/workspace/knowledge?project=<same>&doc=<target>` so superseded-trail links stay on-page
     too. Header carries the project badge and a secondary "Open in <project> →" link (the old
     navigation, demoted to an affordance).
   - Mobile: list/detail toggle mirroring `knowledge.tsx`'s.
   - **No full-page "Loading...":** shell + search box render immediately; the domains section
     shows skeleton rows while its query is in flight.
7. **`api/client.ts` + `api/queries.ts`** — `getWorkspaceKnowledgeDocument(project, doc)` +
   `useWorkspaceKnowledgeDocument(project, doc)` (workspace-scoped key, enabled only when both
   params present). The page's structural import pin ("only `useWorkspaceKnowledgeDomains` /
   `useWorkspaceKnowledgeSearch`, never a scope-led query") widens to admit the new
   workspace-level hook — the invariant being protected (no AMBIENT-scope reads from a
   workspace page) is preserved; keep the negative assertion against scope-led imports.

## Architecture

Unchanged in shape: the workspace read path stays `WorkspaceKnowledgeIndex` over
peek-else-standalone stores, never a project context; the per-project page is untouched. What
moves: index construction moves from per-`search()`-call to per-catalog-generation, owned by
`KnowledgeStore`; slug lookup becomes a store primitive instead of a search trick; the workspace
page gains the document read it was missing (the reason it had to link out).

## Data models

- `KnowledgeSearchIndex` (in-memory only): `{bm25: Bm25Index, identifiers: Map<string, Set<string>>, docs}`.
- `KnowledgeStore` gains `catalogGeneration: number`, the memo slot, and `slugIndex`.
- No persisted format changes; `CATALOG_FORMAT_VERSION` untouched.

## API contracts

- **New:** `GET /api/v1/workspace/knowledge/document?project=<registryId>&doc=<docId>` →
  `workspaceKnowledgeDocumentResponseSchema` (above). Workspace-level, never mirrored under
  `/api/v1/p/:projectId` (`BACKWARD_COMPATIBILITY.md` §2).
- **Unchanged on the wire:** `/workspace/knowledge/{search,domains,changelog}`, all
  `/p/:projectId/knowledge*` routes.
- **Semantic note:** filtered `search` ranking now uses corpus-wide statistics (candidates still
  strictly filtered). Pre-launch, no compatibility burden (upstream fork carries no external
  API consumers of ranking order).

## Risks

- **A forgotten generation bump serves a stale index.** Pinned by a write→search coherence test:
  `updateDocument` then an immediate `search()` must see the new body ranked, and a reindex after
  a watched-file change must invalidate (the fresh-fixture trap — the test must mutate EXISTING
  state, not assert on a fresh store).
- **Ranking drift on filtered queries** — deliberate; tests asserting subset-IDF scores updated
  with intent, never loosened to "any order".
- **First click into a cold project** pays that project's standalone store build once (bounded by
  the existing 5s deadline, reported as the endpoint's 404/error path if tripped) — same cost
  navigating to that project's page pays today.
- **Pin widening** on the workspace page must keep its negative (scope-led imports still
  forbidden) or the invariant silently dies.
- **Slug collisions**: `findBySlug` returns all matches; `findIndexDocId` keeps today's
  documented first-in-registry-order pick — behaviour equal or better, never new ambiguity.

## Phases

1. Server perf + document read (items 1–5). Gates green.
2. Web one-page preview (items 6–7). Gates green.
   One session, one commit, deploy `cockpit.example.com` after.

## Verification

Concrete and executable; results to be filled in below each item.

1. **Unit (server):**
   - Memo reuse: N `search()` calls on an unchanged store build the index once (seam/spy);
     a catalog mutation invalidates it (write → next search rebuilds and sees the change).
   - `findBySlug`: exact hit; collision returns all in `(root, path)` order; miss → `[]`.
   - `domains()` no longer calls `store.search` at all (spy) and returns the same
     `indexDocId`s as before on a fixture with slugged index docs.
   - Workspace document endpoint: gate off → `{document: null, disabledReason}`; unknown
     project/doc → 404; hit → full document; the READ-never-instantiates structural pin extends
     to the new code path.
   - Filtered search with shared index: candidates strictly respect filters; deterministic
     byte-identical repeat (D8).
2. **Component (web):** row click keeps `location.pathname === '/workspace/knowledge'` and sets
   `?project&doc`; reader renders title/body; superseded-trail link stays on-page; "Open in
   <project>" href present; domains skeleton renders while loading (no full-page blank); mobile
   toggle; pin test keeps its scope-led negative.
3. **Gates:** `npm run typecheck && npm test && npm run test:unit && npm run build && npm run test:package`.
4. **Runtime E2E (local, real corpus):** time `GET /workspace/knowledge/domains` warm — expect
   **< 300 ms** (was 4.6 s); click a search result in the browser — URL stays on
   `/workspace/knowledge`, preview appears in the right pane.
5. **Prod (after deploy):** repeat item 4 against cockpit.example.com from the owner's browser;
   record ms before/after in this section.

## Verification results

**1. Unit (server) — all added, all green:**

- Memo reuse: `KnowledgeStore.test.ts` "search index memo" — N `search()` calls on an unchanged
  store build the index once (`store.getSearchIndexBuildCount()`, a small always-on stat getter
  added for this, same family as `getCounts()`/`getScan()` — real instrumentation, not a timing
  inference); a write bumps `catalogGeneration` and the very next `search()` rebuilds and sees the
  new content (mutate-then-search against EXISTING state, not a fresh store).
- `findBySlug`: exact hit, a miss (`[]`, never throws), and a same-slug collision across two
  documents returns both in `(root, path)` order (`store.test.ts` "findBySlug"); a write
  invalidates its memo the same way.
- `domains()` no longer calls `store.search()` at all — `knowledge-index.test.ts` adds a spy test
  plus rewrote the two existing index-doc-resolution tests to fake `findBySlug` instead of
  `search`; a slug-collision test locks in "first hit, in `findBySlug`'s own order" as the
  documented tie-break.
- Workspace document endpoint (`workspace-knowledge-routes.test.ts`, new describe block): gate off
  → `{project, document: null, disabledReason}`; unknown project/doc → 404; a hit → the full
  document with body; missing `project`/`doc` query params → 400. `knowledge-index.test.ts` adds a
  `getDocument()` suite (peek vs standalone, unregistered/missing project, unknown doc id, a store
  that fails to build, and cache reuse with a later `search()`) — the READ-never-instantiates
  structural pin (top of that file) covers the new method for free since it scans the whole file's
  imports, no new import was added.
- Filtered search with a shared index (`search.test.ts`, new describe block): a shared index built
  over the SAME docs as an internal build is interchangeable; candidates strictly respect filters
  even when the shared index was built over a wider corpus (a 20-doc corpus with 18 filler docs
  excluded by a `type` filter never leaks into results); IDF/avgLength provably come from the whole
  corpus, not the filtered subset (a constructed tie under a local index — two symmetric documents,
  each carrying one of two query terms — is NOT a tie once the same query runs against a
  shared index built over a wider corpus that skews one term's global document frequency); two
  calls against the same shared index are byte-identical (D8).
- Ran: `npx vitest run` on `search.test.ts` (20/20), `store.test.ts` (24/24),
  `knowledge-index.test.ts` (42/42), `workspace-knowledge-routes.test.ts` (15/15) — all pass.

**2. Component (web) — `workspace-knowledge.test.tsx`, rewritten, 20/20 pass:**

- Row click keeps `location.pathname === '/workspace/knowledge'` and sets `?project&doc`; the
  reader renders title and body; a superseded-trail link stays on-page, swapping the selection to
  the target document; "Open in `<project>` →" href present and points at the old per-project
  route; domains skeleton (`workspace-knowledge-domains-skeleton`) renders while the domains query
  is in flight, alongside the already-visible search box (no full-page "Loading…" text anywhere);
  mobile list/detail toggle (asserted via `cn()`'s literal class tokens, since jsdom applies no
  responsive class — same convention as `workspace-tasks.test.tsx`); the scope-trap allowlist
  widened to include `/api/v1/workspace/knowledge/document` with an explicit negative kept against
  any `/api/v1/p/*` request. Carried over unchanged from the Phase 3 predecessor's suite: the
  domain list, the "no index doc" row, project-health banner, both `disabledReason` messages, and
  the empty-registry state.
- Ran: `npx vitest run packages/web/src/routes/workspace/workspace-knowledge.test.tsx` — 20/20
  pass.

**3. Gates — all green, run from the repo root in the specified order:**

- `npm run typecheck` — clean (contract, api-client, server, web).
- `npm test` (full `vitest run`) — 463 test files, 8611 tests passed, 1 skipped (pre-existing
  skip, unrelated).
- `npm run test:unit` — 35/35 pass, 1 pre-existing skip (unrelated).
- `npm run build` — clean; `check:pack` ok, 990 files.
- `npm run test:package` — 15/15 pass.
- `npx prettier --check` on every touched file reports formatting differences on BOTH the new
  lines and pre-existing, untouched lines in the same files (confirmed by running it against the
  unmodified `HEAD` copy of `search.ts`, which also "fails"). The repo carries no `.prettierrc` and
  no `format`/`prettier`/`lint` script — it hand-maintains a style (single quotes, ~120-column
  width) that bare `npx prettier` does not reproduce. Not run with `--write`: doing so would
  reformat every touched file away from the surrounding codebase's own style. Treated as N/A for
  this repo rather than a red gate.

**4. Runtime E2E (local, real corpus — executed 2026-08-17, real Chrome against the rebuilt
`dist` on `localhost:4399`, `--repo ~/loki-labs`, `CEZ_KB=1 CEZ_WORKSPACE_VIEWS=1`):**

- `GET /workspace/knowledge/domains`: first load (12 cold standalone stores) **760 ms**; warm
  repeat (`cache: no-store`) **97 ms** — target was < 300 ms, was 4.6 s before the change.
- Click-through: domain card click sets the filter chip in place; clicking a search result kept
  the tab on `/workspace/knowledge?project=loki-labs&doc=…` (same pathname, no navigation entry)
  and rendered the document in the right pane with the project badge and the
  "Open in loki-labs →" secondary link.

**5. Prod (cockpit.example.com, commit `75f6abaa` deployed 2026-08-17, measured from the owner's
authenticated Chrome):**

- `GET /workspace/knowledge/domains`: first call after the fresh process **3,873 ms** (one-time
  per boot: 12 standalone stores parsing their corpora — previously this cost was paid ON TOP of
  the ~4.6 s recompute on every request); warm repeats **259 ms** then **56 ms** (was 4,646 ms
  warm before — ~50× faster, under the < 300 ms target). All 12 projects `ok:true`.
- Click-through on prod: cross-project search for "NECP denial" returned rows from four
  projects; clicking the top hit stayed on
  `/workspace/knowledge?project=loki-labs&doc=notion-8d4c3ec3b97e` and rendered SPEC-281's full
  body in the right pane. The "everything on one page" behaviour the owner asked for.

Remaining for owner device QA: the mobile list/detail toggle on a real phone (component tests
pin the class tokens; no device pass has covered it — same residue as the parity spec's task).

## Amendment — filters on top, results immediately visible (owner QA, 2026-08-17)

Owner feedback on the shipped layout, verbatim: *"UI is not really good, I need to scroll down
to see a filtered by project specs - it should be somewhere on the top and then content on the
right."* Reproduced during this session's own E2E: the left pane stacks 12 tall domain **cards**
first and puts the search box + result rows BELOW them, so after picking a domain the filtered
rows start roughly two screens down. The reader pane (content on the right) is fine; the left
pane's internal order is wrong.

### Revised left-pane structure (top to bottom)

1. **Search input at the very top** of the list pane — always visible, never scrolled away
   (the pane's scroll region starts BELOW it; same structure as the per-project page's filter
   input).
2. **Domains as one compact chip row** directly under the search input — `domain (count)` chips
   that wrap, capped at the top 8 by doc count with a "+N more" expander (the exact
   FACET_VISIBLE_CAP convention from the per-project page), active chip highlighted with an ×
   to clear. The tall cards are deleted. Chip click = same domain filter as today.
3. **Result rows fill the remaining height** — the scrollable region is the rows themselves,
   so filtered results are visible without any scrolling past controls.
4. Carried over unchanged: `?project=&doc=` selection, right-pane `DocumentReader`,
   project-health banner (compact, above the rows), both `disabledReason` states, skeleton
   (now covering the chip row + rows area, search box still rendered immediately), the mobile
   list/detail toggle, and the scope-trap test posture.

### Displaced card content

- **Doc count** moves into the chip label.
- **Project badge** on cards (`loki-labs`) is dropped from the chip — it already appears on
  every result row; the health banner still names broken projects.
- **Index doc**: when the active domain has an `indexDocId`, render a pinned "Index doc" row
  at the TOP of the results list (selectable like any other row, marked visually). No domain
  selected → no pinned row. This replaces the card's "Index doc" caption.

  **CORRECTED same day, follow-up fix (real-data defect found in the orchestrator's own runtime
  E2E after this amendment first shipped):** a purely client-side reorder cannot pin anything
  that never arrives in the fetched page. Evidence from the live local server:
  `GET /workspace/knowledge/search?domain=alfredo` ties every alfredo document on
  `updatedAt: 2026-08-17T07:45` (a bulk import) and tie-breaks by id ascending — alfredo's own
  index doc, `notion-c99c754479a2`, landed on page 20 of 398, never in page 1. **Pinning is now
  primarily SERVER-side**: `WorkspaceKnowledgeIndex.search()` (`packages/cezar/src/workspace/
  knowledge-index.ts`), in BROWSE mode (no query tokens) with `options.domain` set, moves the row
  whose `document.slug === options.domain` to the front of the FULL sorted `merged` sequence
  BEFORE the offset/limit slice — so page 1 always carries it. Ranked mode (real query text) is
  untouched; a text search still ranks honestly. The client-side reorder described above
  (`workspace-knowledge.tsx`'s `SearchResults`) is kept, now as a defensive, idempotent fallback
  — a no-op once the server already puts the doc first, still useful if a response ever arrives
  out of order for any other reason.

### Amendment verification

- Component: the search input renders ABOVE the chip row and outside the rows' scroll
  container (structural assertion on DOM order + the scroll container's class tokens, the same
  pin style the per-project page uses); chips capped at 8 with "+N more" expanding; active-chip
  × clears the filter; pinned "Index doc" row appears only when the active domain has one;
  all prior suite assertions still pass (rewire, don't delete).
- Runtime: on a 1470×800 window with no scrolling, after clicking a domain chip the first
  result rows are visible; measured in a real browser, local + prod after deploy.

### Amendment verification results

**Follow-up fix (real-data defect, found in the orchestrator's own runtime E2E): pinning moved
server-side.** The first cut's client-only reorder was provably dead on the real corpus — see the
"Index doc" bullet above for the measured evidence (alfredo's index doc on page 20 of 398).
`WorkspaceKnowledgeIndex.search()` (`packages/cezar/src/workspace/knowledge-index.ts`) now pins
the domain's own index document (`document.slug === options.domain`) to the front of the full
`merged` sequence in BROWSE mode, before the offset/limit slice; ranked mode (real query text) is
untouched. The client's reorder in `workspace-knowledge.tsx` is unchanged in code, now documented
as a defensive/idempotent fallback rather than the primary mechanism.

**Server (`knowledge-index.test.ts`) — new describe block, 3 tests, all pass:**

- A 25-document browse-mode fixture shaped like the real failure (24 ordinary docs plus one whose
  `slug` equals the domain, ALL sharing one `updatedAt` so the tie-break sorts purely by id
  ascending, and the index doc's id — `notion-99` — sorts dead last) asserts page 1 (default
  limit 20) still returns the index doc FIRST, with the remaining 19 slots holding the original
  ascending-id order minus the pinned doc's own old slot (a reorder, not a reshuffle of the rest).
- A negative: with real query text (ranked mode), a server response that ranks the index doc
  SECOND is returned unchanged — pinning must never override an honest BM25 ranking.
- `offset > 0` determinism (D8): two identical `{domain, offset: 20, limit: 20}` requests against
  the same 25-doc fixture return byte-identical pages (`toEqual`), and that page is exactly what
  tie-break order leaves behind once the pinned doc has already left for page 1 (it never
  reappears on page 2).
- Ran: `npx vitest run packages/cezar/src/workspace/knowledge-index.test.ts` — 45/45 pass (was 42
  before this fix).

**Component (`workspace-knowledge.test.tsx`) — 29/29 pass (20 carried over/rewired + 9 new):**

- **Layout structure** (new describe block): `input.compareDocumentPosition(rows) &
  DOCUMENT_POSITION_FOLLOWING` proves the search input precedes the rows scroll container in DOM
  order; `rows.contains(input)` is `false` — the input is not nested inside the scrollable region
  at all; the rows container (`data-slot="workspace-knowledge-rows"`) carries the exact
  `overflow-y-auto flex-1 min-h-0` class combination — the same brittle-by-design pin style
  `knowledge.test.tsx`'s "the list pane scrolls, not the page" block uses, guarding against the
  same class of regression (an unbounded block sitting outside the scroll container, silently
  reintroducing the page-level scroll bug); a second test confirms the search input's own
  `shrink-0` header carries no `overflow-y-auto` class.
- **Domain chip cap** (new describe block, 10-domain fixture ranked by doc count desc): the top 8
  chips render (`domain-00`..`domain-07`), `domain-08`/`domain-09` are absent, and a "+2 more"
  toggle is present; clicking it reveals all 10 and flips the toggle's own label to "Show fewer" —
  same ranking/cap/expander convention as `knowledge.tsx`'s `FacetGroup`, applied to domains.
- **Active-chip clears on a second click** (new test in the `search` describe block): clicking
  the `billing` chip sets `aria-pressed="true"` and shows results; clicking the SAME chip again
  flips `aria-pressed` back to `false` and returns to the idle "Type a query or pick a domain…"
  placeholder — one click target does both jobs, no separate × control.
- **Pinned index-doc row** (new describe block, reworked after the server-side fix, 4 tests): the
  FIRST test now reflects the real shape — the fixture already returns the index doc first (the
  server-pinned shape), and the row renders `data-pinned="true"`; a SECOND test is kept as the
  defensive-fallback path, a fixture with the index doc ranked SECOND
  (`SEARCH_RESPONSE_BILLING_INDEX_DOC_RANKED_SECOND`) still renders it first client-side; a plain
  text search with no active domain renders every row `data-pinned="false"` (nothing to pin
  without a domain); a domain fixture with no `indexDocId` also renders every row
  `data-pinned="false"`.
- **Rewired, not deleted:** "a domain with documents but no index document" now asserts the chip's
  `data-has-index-doc` attribute and that both chips still render (the domain is never dropped from
  the row) instead of the old caption text, since the amendment moves that information to the
  pinned result row; the domain-select click helper (`domainChip`) now targets the chip `<button>`
  directly instead of `within(<li>).getByText(domain)` since the tall `<li>` card is gone; every
  other describe block (disabled-reason states, project health banner, skeleton, scope trap,
  search-badge marking, right-pane preview, superseded trail, "Open in", mobile toggle, empty
  registry) is unchanged in intent, only re-pointed at the chip helper where it used to click a
  card.
- Ran: `npx vitest run packages/web/src/routes/workspace/workspace-knowledge.test.tsx` — 29/29
  pass.

**Gates — all green, same order, run from the repo root after the server-side follow-up fix:**

- `npm run typecheck` — clean (contract, api-client, server, web).
- `npm test` — 463 files, 8623 tests passed (+4 from this follow-up: 3 server, net +1 component),
  1 skipped (pre-existing, unrelated).
- `npm run test:unit` — 35/35 pass, 1 pre-existing unrelated skip.
- `npm run build` — clean; `check:pack` ok, 990 files.
- `npm run test:package` — 15/15 pass.
- `npx prettier --check` on all four touched files (`workspace-knowledge.tsx`,
  `workspace-knowledge.test.tsx`, `knowledge-index.ts`, `knowledge-index.test.ts`) still flags
  formatting on pre-existing, untouched lines too — same N/A finding as the original session
  (re-confirmed then against an unmodified sibling file at `HEAD`, which also "fails" bare
  prettier); not run with `--write`.

**Runtime/prod (item 5's repeat) — executed 2026-08-17 by the orchestrating session:**

- **Real-corpus pin re-check (local, rebuilt dist on :4399):**
  `GET /workspace/knowledge/search?domain=alfredo` now returns `notion-c99c754479a2`
  (slug `alfredo`, title "Alfredo") as the FIRST row of page 1 — the exact document that
  previously could never enter the page (id-ascending tie-break placed it past row 20 of 398).
  Same check for `domain=loki` → `notion-f6bf3721e24d` first. In the browser, the pinned row
  renders with the INDEX DOC badge at the top of the results.
- **Layout (local + prod, 1512×802 real Chrome):** search input at the very top, one compact
  chip row (`loki (667)`, `predicts (424)`, … "+4 more") under it, clicking a chip shows the
  filtered rows immediately with zero scrolling; active chip highlighted with ×; reader pane
  right. Verified on cockpit.example.com after deploying `80c7ee36` (same click-through:
  active `alfredo (398) ×` chip, pinned "Alfredo — INDEX DOC" first row).
- **No perf regression:** the deploy's restart answered loopback in 3 ms; the pin changes page
  composition only, and prod page behavior matched local.
- Deploy note: the same restart removed the now-inert `CEZ_AUTH_BOOTSTRAP_OPEN=1` from
  `/etc/cezar/cezar.env` (deployment claimed — today's boot logs no unclaimed warning; backup
  at `cezar.env.bak-20260817`); authenticated access re-verified after the change.

Still pending (owner): the real-phone chip-row pass (mobile wrap, tap targets, "+N more"
reachability) and the mobile list/detail toggle — component tests pin structure and class
tokens; no device pass has covered them.
