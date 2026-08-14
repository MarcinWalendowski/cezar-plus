# Knowledge domains and a project-correlated changelog

> **Status:** Phases 1–3 + the changelog **read** implemented, **QA Needed** — no runtime E2E has
> run, and Phase 4's write path is deliberately unbuilt (see the status block below) ·
> **Date:** 2026-08-14, status corrected 2026-08-15 — this header read "specified, not
> implemented" while the body already said the opposite, so the file contradicted itself and the
> header is what a scanning reader keeps
> **Completes:** Phase 2 (the Knowledge half) of
> `.ai/specs/2026-08-14-workspace-level-navigation.md`.
> **Extends:** `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` (F1) — this adds two fields
> and a cross-project reader to that substrate. It does not build a second knowledge system.

## TLDR

Two new front-matter fields (`domain`, `changeType`), a cross-project read that never builds a
project context, and a workspace Knowledge page whose landing view is **one document per domain
saying what is true now**.

The owner asked for this because the Notion knowledge page does not do it. Measured, today: **949
KB, 3,808 lines, 311 chronological entries** under a single `## Notes log` heading; `## Decisions`
abandoned after nine days (last entry 2026-07-09); `## Overview` and `## References` never filled
in at all. There is no per-domain grouping anywhere in it.

## Problem

### 1 — an append-log cannot answer "what is true now"

The page carries **55 `CORRECTED` and 17 `SUPERSEDED`** in-place markers. That convention works —
it is the one thing worth keeping — but it means the current state of any topic is only
recoverable by reading forward through several dated entries and applying their markers in order.

For a human that is slow. For an agent doing knowledge-first reading before a task, it is worse
than slow: it is the failure mode where the *first* matching entry is stale and reads as current.
This repo's own doctrine has been caught by it twice in one day.

A domain document inverts it: **the document is the current state, and history is git.** Nothing is
appended to it; it is edited, and the diff is the log.

### 2 — cezar's knowledge base already has most of the machinery, and none of the axis

`knowledgeDocumentSchema` (`contract/src/knowledge.ts:77-109`) already carries `project`
(absent = workspace-wide), `status` (`current|superseded|draft`), `supersedes[]`, `supersededBy`,
`supersededAt`, `tags[]`, `identifiers[]`, `links[]`, `backlinkCount`. `parseDocument`
(`knowledge/parse.ts:66`) already reads every one of them out of front matter, with status
normalization and superseded-demotion in search.

"Store all previous specs" is also already done: `.ai/specs` is a `discovered` root
(`knowledge/paths.ts:51-57`), read-only and indexed.

What is missing is the grouping axis, and one that is genuinely absent: a **changelog**. Nothing in
`packages/cezar/src`, `packages/web/src` or `packages/contract/src` models a dated change event.

### 3 — the store is per-project, so "the workspace knowledge base" does not exist

`KnowledgeStore` is one instance per project — `create(repoRoot, dataDir, options)`
(`knowledge/store.ts:108`), roots resolved from that project's paths (`store.ts:152-158`), `search()`
over `this.documents` only (`store.ts:346-370`). `knowledge-routes.ts` reads
`c.get('project').knowledgeStore` on every handler.

The `~/.cezar/knowledge/` "workspace" root is **not** cross-project sharing, despite the name: it is
a machine-wide scratch mount that each project's store separately re-scans and folds into its own
index. Two projects reading it get two copies, and a document in project A's own root is invisible
to project B by construction.

### 4 — parallel worktrees make a single shared file the wrong container

The owner's constraint, verbatim:

> "repo is not good, because there are multiple worktrees running on related stuff, so all specs
> needs to be committed before any implementation."

A changelog kept as one `CHANGELOG.md` would be edited by every concurrent run, which is a
guaranteed conflict and — worse — a silent lost update when two agents write it in the same
window. This is the same hazard that produced the `next-spec` allocator rule.

## Solution

### D1 — a domain is a field, not a document type

`domain?: string` in front matter, parsed exactly like `project` and carried on
`knowledgeDocumentSchema`. Additive and optional.

**Not** a new member of `knowledgeDocTypeSchema` (`'note'|'decision'|'spec'|'reference'|'meeting'|'runbook'`).
A domain is an *axis*, not a kind: a decision belongs to a domain, so does a spec, so does a
runbook. Making it a type would force every document to choose between saying what it is and saying
what it is about. It also keeps a closed wire enum closed, which matters in a released package —
an older client's zod parse **rejects** an enum member it does not know, so widening that enum is
the breaking change the field is not.

The **domain index** is then just the document whose `slug` equals the domain id, by convention at
`<knowledge-root>/domains/<id>.md`. No new storage, no registry of domains: the domain list is
`distinct(domain)` over the index, and a domain with entries but no index document is a real
state the page must show honestly rather than hide.

### D2 — a domain document states current behaviour; it is never appended to

Enforced by convention and by the page, not by the parser:

- The domain document says what is true **now**. Editing it is the update.
- A superseded decision keeps its own document, marked `status: superseded` +
  `supersededBy: <id>`, which the substrate already demotes in search rather than hiding.
- The domain document links to those with `[[wikilinks]]`, which the substrate already resolves
  into `links[]` and `backlinkCount`.

This is the one place this spec deliberately departs from the Notion page it is replacing, and §1
is the measurement that justifies it.

### D3 — the changelog is a projection over knowledge documents, not a second store

A changelog entry is a knowledge document carrying `changeType: Added|Changed|Fixed|Removed` plus
the existing `updatedAt`, `project`, `domain`. Presence of `changeType` is what makes it an entry.

It therefore inherits — for free — the scanner, the catalog cache, BM25 search, wikilinks,
backlinks, the mount config, the web reader, and the proposal/apply write path. A separate
changelog store would reimplement all of that and then drift from it.

**One file per entry**, `<knowledge-root>/changelog/<YYYY-MM-DD>-<slug>.md`. That is D4's answer to
§4: two concurrent worktrees write two files and both survive; there is no shared file to lose an
update in. Merging is a read-time sort, which is what the run index already does across projects.

### D4 — one vocabulary for `project`, shared by knowledge and changelog

The Notion original runs two near-identical enums — Tasks `Project` (8 options) and Changelog
`Area` (11) — which agree on 7 values and silently diverge on `Grocey`, so a grocery changelog row
tagged the obvious way lands **empty**, reading on the board as "untagged" rather than as an error.

Here there is exactly one vocabulary: the project registry, which already exists and is already the
thing every other workspace surface enumerates. `domain` is free-form (an emergent axis, not a
fixed list) and its valid set is whatever the index contains.

### D5 — cross-project read: peek, else open a standalone store, never build

`GET /api/v1/workspace/knowledge/search` and `GET /api/v1/workspace/knowledge/domains`, in a new
`workspace/knowledge-index.ts` + `server/workspace-knowledge-routes.ts`.

```
contexts.peek(projectId)  → use that context's knowledgeStore      (already built)
otherwise                 → KnowledgeStore.create(root, dataDir)   (a plain static factory)
```

`KnowledgeStore.create` needs only `(repoRoot, dataDir, options)` — no `ProjectContext`. So this is
the same peek-then-open shape as `workspace-run-mutations-routes.ts`, for the same reason: building
a context runs `pruneOrphans` → `reclaimWorktrees` → `manager.recover()`, and **typing into a
search box must not resume agent runs.**

Unlike the run mutations there is no `keepLive` analogue — a `KnowledgeStore` read reconciles
nothing and persists nothing. What it does do is *scan*, which is why D6 exists.

### D6 — standalone stores are built lazily, capped, and cached with an honest staleness story

Indexing every project on the first workspace search is the cost risk. So:

- Built **lazily per project** and held on the index instance, not per request.
- Concurrency cap of 4, as in the git overview, and a per-project deadline; a project that
  exceeds it is an `{ ok: false, reason }` row, never a silent omission.
- The catalog cache the store already keeps (`CATALOG_FORMAT_VERSION`, mtime+size manifest) does
  the repeat work, so the second search is cheap.

`GET /api/v1/workspace/knowledge/*` gates on **both** `capabilities.knowledge` (`CEZ_KB=1`) and
`capabilities.workspaceViews` (`CEZ_WORKSPACE_VIEWS=1`) — it is a knowledge feature *and* a
cross-project aggregate, and either being off is a real reason not to serve it. Off → 200 with a
schema-valid empty payload; mutators 409; never 404 (D19).

**A two-flag gate cannot say which flag is off.** So the empty payload names the missing capability
explicitly, and the page renders that reason rather than a generic "off" — otherwise the user sets
one flag, restarts, sees the same blank page and has no way to tell what happened.

### D7 — write path: propose, never auto-apply

Knowledge writes already go through `GET /knowledge/proposals` + `POST /knowledge/proposals/apply`.
An autonomous run's knowledge or changelog edit lands as a **proposal**, and applying it stays a
click. Same reasoning as the note review gate: an agent that silently rewrites the document the
next agent reads as ground truth is how a wrong fact becomes doctrine.

### D8 — no external Notion-alike, and here is the answer to the question

The owner asked whether an open-source Notion equivalent could store this. The honest answer is
that the shape being described — markdown files with YAML front matter, in git, one file per
entry — **is** the storage model of Obsidian, Silverbullet, Logseq and Docmost. So the data stays
portable to any of them, by construction, with no exporter.

What none of them would give is the part that matters here: cezar already indexes, searches,
renders, backlinks and *writes* these files, and its agents already read them knowledge-first
during a run. Adding a second system would mean two sources of truth for the thing whose entire
purpose is to be the single one. Recorded as a decision so it is not re-litigated.

## Architecture

```
packages/contract/src/knowledge.ts                        + domain?, changeType?  (additive)
packages/cezar/src/knowledge/parse.ts                     parse both, like `project`
packages/cezar/src/knowledge/store.ts                     index them; domain facet
packages/cezar/src/knowledge/types.ts                     catalog entry follows the wire shape
packages/cezar/src/workspace/knowledge-index.ts           new — peek-else-create, capped, lazy
packages/cezar/src/server/workspace-knowledge-routes.ts   new — search + domains + changelog
packages/cezar/src/server/server.ts                       mount into workspaceV1
packages/web/src/routes/workspace/workspace-knowledge.tsx new — domains landing + search
packages/web/src/routes/workspace/workspace-changelog.tsx new — the dated projection
packages/web/src/routes.tsx                               two routes
packages/web/src/components/nav-items.ts                  workspaceTo on Knowledge
BACKWARD_COMPATIBILITY.md §2                              inventory
```

## Data Models

Additive front matter, both optional:

```yaml
domain: billing            # free-form axis; absent = not filed under a domain
changeType: Fixed          # Added | Changed | Fixed | Removed; presence = changelog entry
```

Correlation key is the **spec id** (`YYYY-MM-DD-title`, cezar's existing convention), written
verbatim into `identifiers[]`. That is deliberately the same mechanism the Notion original uses —
a shared id referenced in prose — because it is the only one there that actually works: 913 of the
page's 3,808 lines carry a `SPEC-\d+` reference, while native cross-links are used **twice** in the
whole document and relation properties do not exist on either database.

## API Contracts

```
GET /api/v1/workspace/knowledge/search?q=&domain=&project=&type=&status=&limit=&offset=
GET /api/v1/workspace/knowledge/domains        → [{ domain, docCount, projects[], indexDocId? }]
GET /api/v1/workspace/knowledge/changelog?domain=&project=&since=&limit=
```

Workspace-level, single-mount, never mirrored under `/api/v1/p/` (BC §2). Project-scoped
`/knowledge/*` is untouched.

## Phases

1. `domain` + `changeType` through parse → store → contract → the per-project facets. No new
   routes; the axis exists and the existing page can filter on it.
2. `workspace/knowledge-index.ts` + the search route (D5, D6).
3. The workspace Knowledge page: domains landing, per-domain view, cross-project search.
4. The changelog projection and its write path (D7).

Phase 1 is shippable alone and is what makes every later phase testable.

**Status 2026-08-14:** Phases 1, 2 and the changelog **read** half of Phase 4 are implemented.
Phase 3 (the page) is in progress. Phase 4's **write** path is deliberately not built: a changelog
entry is a knowledge document, so writing one already goes through the existing per-project
`POST /knowledge` + `POST /knowledge/proposals/apply`, and D7's propose-never-auto-apply guarantee
is inherited rather than rebuilt. Building a second write path would have been the duplication this
spec argues against everywhere else.

**One gap had to be closed in the substrate to build any of it.** `KnowledgeStore` had no way to
enumerate documents: `search()` applies its `type`/`tag`/`status`/`root` filters and then discards
the result whenever the query tokenizes empty (`search.ts:213-222`), and `GET /knowledge` answers
facet counts and never a document array — so the search docstring's advice to "browse via
`GET /knowledge`" pointed nowhere. Added `KnowledgeStore.listDocuments()` (a public delegation to
the private `orderedEntries()`) and corrected that docstring in place.

The tempting alternative — querying each `changeType` value through BM25 — was rejected rather than
shipped: `changeType` is frontmatter and not part of `SearchableDocument`, so it would have matched
on incidental body-text overlap and returned a corpus shaped by word coincidence. That is the
silent-narrowing failure this spec's other guards exist to prevent.

**And then the same trap caught this spec's own consumer.** `WorkspaceKnowledgeIndex.search()`
forwarded to the per-project `store.search()` and applied `domain` as a post-filter over its
results — but `search()` returns `[]` whenever the query tokenizes empty, so the post-filter ran
over an empty array. The page's primary affordance is **clicking a domain row**, which searches with
`domain` set and no query text, so every domain rendered "No documents match." directly beneath a
row stating its document count. The two halves of the page contradicted each other and the count was
the honest one.

Worth stating plainly, because it is the reusable lesson: the docblock warning against exactly this
had been written earlier the same day, three functions away, and the consumer walked into it anyway.
**A docblock is not a guard.** The fix follows `changelog()`'s own precedent in the same file —
browse through `listDocuments()` when there is nothing to rank and a filter to honour — and the
regression test is required to fail against the pre-fix code, since a test that passes before the
fix would be testing nothing. Empty query with *no* filter still returns empty; the distinction
being defended is "browse a filtered slice" versus "dump the corpus".

**Found while fixing the above, out of scope, and left alone deliberately: a one-character query
returns nothing, silently.** `search.ts`'s `TOKEN_RE` is `[a-z0-9][a-z0-9_-]{1,31}` — a **two**
character minimum — so a literal single-character query tokenizes to zero tokens and hits the same
short-circuit. That is true of the existing per-project search box today, independent of anything
here: type `a` and you get "No documents match", which is indistinguishable from a genuine empty
result.

It surfaced because five pre-existing tests used `'q'` as throwaway query text against a fake that
ignored its argument; once the real `tokenize()` became load-bearing, those five correctly started
routing through the browse/empty branch. They were repointed to `'query'`, restoring their original
intent — the alternative, relaxing `TOKEN_RE`, would have changed indexing semantics corpus-wide to
make five placeholder strings keep working, which is the tail wagging the dog.

**Not fixed here, and the right fix is not in this layer.** Widening `TOKEN_RE` would alter every
document's index for the sake of a query nobody usefully types. The honest fix is a UI affordance —
tell the user a search needs two characters — which belongs to the page, not the index. Recorded so
the next person to see an empty result for `a` finds this instead of re-deriving it. Note the browse
path above now *improves* this case: a one-character query **with a domain filter** browses
correctly rather than returning nothing, because both are "no tokens to rank".

**Known gap, not a defect: the changelog route ships with no UI consumer.**
`GET /api/v1/workspace/knowledge/changelog` exists in the index, the route, the contract and
`BACKWARD_COMPATIBILITY.md`, but `/workspace/knowledge` reads only `domains` and `search` —
`workspace-changelog.tsx` (named in the Files table above) was not built. So the changelog
projection has automated coverage but **no browser path at all**, and the runtime E2E below cannot
exercise it. Recorded here so the next session does not read "changelog read implemented" as
"changelog verified end to end".

## Risks

- **Domains are free-form, so they will be misspelled.** Accepted for v1: the domain list is
  derived from the index, so a typo shows up as a domain with one document — visible, not silent.
  A closed vocabulary is a later decision, and closing it early would be the `Area`-vs-`Project`
  mistake in a new costume.
- **First cross-project search pays a full scan.** Bounded by D6 and cached after; the deadline
  turns a slow project into a row rather than a hang.
- **A domain document can go stale like any other.** Nothing prevents that. What D2 buys is that
  staleness is *visible in one place* rather than distributed across 311 entries.
- **Widening `changeType` later.** It is a new closed enum, so the same released-package caution as
  D1 applies to it from the start.

## Verification

| Guard | Mutation that must turn it red |
|---|---|
| `domain`/`changeType` survive parse → catalog → search result | drop either from the catalog projection |
| A document with **no** `domain` is still indexed and searchable | make `domain` required |
| `workspace/knowledge-index.ts` imports neither `server/project-context.ts` nor `workflows/run.ts`, **and does** import `knowledge/store.ts` (floor) | add either import / empty the file |
| A project with a built context is searched through **that** store, not a second one | skip the peek |
| A project whose root is gone is an `ok:false` row; every other project still returns results | drop the row |
| At most 4 stores built concurrently — a fake recording its own high-water mark | delete the cap |
| `CEZ_KB` off and `CEZ_WORKSPACE_VIEWS` on → empty payload naming **knowledge**; the reverse names **workspaceViews** | return one generic reason for both (this is the AND-gate blind spot: a single message cannot say which conjunct is false) |
| The domains list includes a domain that has documents but **no** index document | list only domains with an index doc |
| A changelog write lands as a proposal, not a file | apply it directly |
| **A `domain` filter with an EMPTY query returns that domain's documents** | route the empty-query case back through `store.search()` (i.e. restore the original bug) |
| **A whitespace-only query behaves as an empty one**, not as a term to rank | trim instead of tokenizing, or vice versa — whichever the implementation did not choose |
| **An empty query with NO filter returns empty**, not the whole corpus | make the browse path unconditional |
| **A non-empty query still ranks by relevance** — asserted on *ordering*, not membership | route real queries through the browse path too |

The two-flag test must assert **both directions**. One direction passes with the gate hardcoded to
whichever flag the test happens to set.

The four empty-query rows are a regression suite, so the first of them carries an extra obligation:
it must be **observed failing against the pre-fix code**. A regression test authored after the fix
and never run before it proves only that the code agrees with itself.

**The scope-trap guard is an allowlist, and two independent mutations proved why that matters.**
Two agents, working from two independently written test files, each broke the page by adding a
project-scoped call — but they picked *different* URL shapes, because they disagreed about what
actually goes on the wire:

| Mutation | URL shape it assumed | Result |
|---|---|---|
| add `fetch('/api/v1/p/default/repo')` | scoped, with `/p/` | 1 test failed |
| add a `useRepo()` call | bare `/api/v1/repo` — `withApiBase` → `unscoped()` strips `/p/default` when nothing is scoped (`client.ts:288-303`) | 1 test failed |

The allowlist caught **both**. That is the whole argument, demonstrated rather than asserted: a
`/p/`-shaped **blocklist** would have caught only the first and waved the second through, and the
second is the one that actually happens on a workspace page — where the server's own no-prefix
convention then answers with the *boot project's* data, silently and with a 200.

This cost real effort to establish. The wire format was mis-stated three times across two specs
during implementation, from three readings of the same source, and was settled only by capturing an
actual request log. The durable lesson is two-part: **a claim about what goes on the wire has to be
measured at the wire** — and, better, **write the guard so it does not depend on the answer.** The
allowlist holds under either reading, which is why the second lesson outranks the first.

Gates in order, **`npm test -- <path>`, never `npx vitest`** (PLAN D21): `npm run typecheck`,
`npm test`, `npm run build`, `npm run test:package`.

### Runtime E2E — the gate on Done

With `CEZ_KB=1` and `CEZ_WORKSPACE_VIEWS=1`: write a domain document in one project and a
changelog entry in another, open `/workspace/knowledge`, and confirm both projects' documents
appear under the right domain from a single search. Confirm from the run index that opening the
page started **no** runs in any project — the whole point of D5. Until that has run this is
**QA Needed**.

**Click the domain row without typing anything, and confirm documents appear.** This step was added
after the fact, because the version above would have missed the empty-query defect entirely: it
searches *with a query*, and the broken path was the one with none. A domain whose row claims a
document count must not then render "No documents match." — the count and the list have to agree,
and the E2E has to be the thing that notices when they do not.

**The changelog projection has no step here**, and cannot: no page consumes that route (see the
status note above). Its coverage is automated only. Do not read a passing E2E as evidence about the
changelog.
