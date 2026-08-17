# Workspace knowledge: kill the 5s load, preview in place

- **Status:** Implemented (server + web, items 1-3 verified this session; items 4-5 pending owner's runtime/prod pass)
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

Items 4-5 (runtime E2E timing the warm `domains()` call, and the prod repeat after deploy) are
left for the owner, per this session's brief.
