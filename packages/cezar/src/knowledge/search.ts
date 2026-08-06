/**
 * Knowledge base search (F1, W1.3): BM25 plus exact-identifier pinning. A pure function module
 * over a catalog array, no filesystem and no I/O, so it unit tests standalone and runs in
 * parallel with the format adapters (W1.2) rather than behind them. See
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` ("Search and the link graph", Q5, C1)
 * and `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D10 for the decisions that outrank the
 * spec on any conflict.
 *
 * Two stages, never one:
 *
 * 1. **Exact identifier pin.** If the query contains an identifier token (`PREFIX-1234` shaped,
 *    case sensitive by design - Q7 wants this generic across an issue key, an RFC number or a
 *    spec number), every document carrying that identifier forms a pinned prefix, ordered among
 *    themselves by BM25. This exists because BM25 alone measurably failed identifier lookup on
 *    the real corpus: a cross-referenced identifier's IDF collapses toward zero, so a long
 *    document that is actually about it loses to a short document that merely mentions it. A
 *    negative control (C1) proves the pin is load bearing, not decorative: disabling it via
 *    `identifierPinning: false` must make the same assertion fail.
 * 2. **BM25** (`k1=1.2, b=0.75`), title and headings boosted 3x over body via weighted token
 *    repetition. A superseded document's score is halved, never suppressed - "the thing you
 *    asked about was corrected" is an answer, and an empty result is not.
 *
 * The generic type parameter mirrors `links.ts`'s choice: this file owns no shared `types.ts`
 * (W2.1, built later), so it names the minimal shape it needs (`SearchableDocument`) and lets
 * any richer catalog-entry type satisfy it structurally - the wire `KnowledgeDocument` in
 * `packages/contract/src/knowledge.ts` (already scaffolded by W1.1) is a superset of it.
 *
 * Out of scope here, by design: reciprocal-rank fusion with an optional embeddings ranking
 * (`CEZ_KB_EMBEDDINGS=1`, W2.6) is architecturally described as living in this file, but W2.6
 * has not been built yet and its exact call shape is unspecified beyond "fuses below the pin
 * block, never through it" - inventing that seam now would be a guess this package's own test
 * list (search/links only, C1/C12/C13) does not require. W2.6 depends on this file and can add
 * it when it lands.
 */

export type KnowledgeStatusForSearch = 'current' | 'superseded' | 'draft';

export interface SearchableDocument {
  readonly id: string;
  readonly title: string;
  readonly headings?: readonly string[];
  readonly body: string;
  /** Explicit frontmatter `identifiers[]` (Q7's secondary, non-unique index), unioned with
   *  whatever the regex additionally finds in title, headings and body. */
  readonly identifiers?: readonly string[];
  readonly status: KnowledgeStatusForSearch;
  readonly type?: string;
  readonly tags?: readonly string[];
  readonly root?: string;
}

export interface SearchFilters {
  type?: string;
  tag?: string;
  status?: KnowledgeStatusForSearch;
  root?: string;
}

export interface SearchOptions extends SearchFilters {
  limit?: number;
  offset?: number;
  /** Testing seam for C1's negative control only - production code never sets this. `false`
   *  runs BM25 alone with no pin stage, so the identifier-lookup failure the pin exists to fix
   *  is directly reproducible rather than merely asserted. Defaults to `true`. */
  identifierPinning?: boolean;
}

export interface SearchResult<T> {
  results: readonly T[];
  total: number;
  truncated: boolean;
}

// Lowercased before matching; a hyphen or underscore continues a token, so "spec-282" is one
// token, not two.
const TOKEN_RE = /[a-z0-9][a-z0-9_-]{1,31}/g;

// Case sensitive by design (Q7): only a canonically-cased mention counts as "carrying" an
// identifier for pinning purposes, while the (lowercased) BM25 tokenizer above still scores a
// casual lowercase mention as an ordinary term match. That split is what makes the two stages
// distinct rather than redundant.
const IDENTIFIER_RE = /\b([A-Z][A-Z0-9]{1,15}-\d{1,6})\b/g;

const TITLE_WEIGHT = 3;
const HEADING_WEIGHT = 3;
const BODY_WEIGHT = 1;
const K1 = 1.2;
const B = 0.75;
const SUPERSEDED_PENALTY = 0.5;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

/** Identifier tokens found in `text`, in order of first appearance. Case sensitive: matches
 *  `SPEC-282`, not `spec-282`. */
export function extractIdentifiers(text: string): string[] {
  const found: string[] = [];
  const re = new RegExp(IDENTIFIER_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) found.push(m[1]!);
  return found;
}

function documentIdentifiers(doc: SearchableDocument): Set<string> {
  const ids = new Set<string>(doc.identifiers ?? []);
  for (const id of extractIdentifiers(doc.title)) ids.add(id);
  for (const heading of doc.headings ?? []) for (const id of extractIdentifiers(heading)) ids.add(id);
  for (const id of extractIdentifiers(doc.body)) ids.add(id);
  return ids;
}

/** identifier -> the set of document ids carrying it (Q7: a lookup, never a key - two documents
 *  may legitimately claim the same identifier and both belong in the set, C13). */
export function buildIdentifierIndex<T extends SearchableDocument>(
  docs: readonly T[],
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const doc of docs) {
    for (const id of documentIdentifiers(doc)) {
      const set = index.get(id) ?? new Set<string>();
      set.add(doc.id);
      index.set(id, set);
    }
  }
  return index;
}

function weightedTokens(doc: SearchableDocument): string[] {
  const tokens: string[] = [];
  const titleTokens = tokenize(doc.title);
  for (let i = 0; i < TITLE_WEIGHT; i++) tokens.push(...titleTokens);
  const headingTokens = tokenize((doc.headings ?? []).join(' '));
  for (let i = 0; i < HEADING_WEIGHT; i++) tokens.push(...headingTokens);
  const bodyTokens = tokenize(doc.body);
  for (let i = 0; i < BODY_WEIGHT; i++) tokens.push(...bodyTokens);
  return tokens;
}

interface Bm25Doc {
  termFreq: Map<string, number>;
  length: number;
}

interface Bm25Index {
  docs: Map<string, Bm25Doc>;
  docFreq: Map<string, number>;
  totalDocs: number;
  avgLength: number;
}

// Field weighting is realised as weighted token repetition (title/headings tokens counted 3x)
// rather than a separate per-field BM25F combination: it is the simplest implementation that
// matches the spec's stated weights exactly, with no second normalisation scheme to keep in
// sync.
function buildBm25Index<T extends SearchableDocument>(docs: readonly T[]): Bm25Index {
  const bmDocs = new Map<string, Bm25Doc>();
  const docFreq = new Map<string, number>();
  let totalLength = 0;

  for (const doc of docs) {
    const tokens = weightedTokens(doc);
    const termFreq = new Map<string, number>();
    for (const token of tokens) termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    bmDocs.set(doc.id, { termFreq, length: tokens.length });
    totalLength += tokens.length;
    for (const token of termFreq.keys()) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
  }

  const totalDocs = docs.length;
  return { docs: bmDocs, docFreq, totalDocs, avgLength: totalDocs > 0 ? totalLength / totalDocs : 0 };
}

// The `+1` inside the log is the Lucene/Elasticsearch BM25Similarity correction: it keeps IDF
// positive even for a term that appears in most of the corpus, rather than letting it go
// negative the way the textbook Robertson formula can. `k1=1.2, b=0.75` are those same
// defaults (D10).
function idf(index: Bm25Index, term: string): number {
  const n = index.docFreq.get(term) ?? 0;
  return Math.log((index.totalDocs - n + 0.5) / (n + 0.5) + 1);
}

function bm25Score(index: Bm25Index, docId: string, queryTokens: readonly string[]): number {
  const doc = index.docs.get(docId);
  if (!doc) return 0;
  let score = 0;
  for (const term of queryTokens) {
    const tf = doc.termFreq.get(term) ?? 0;
    if (tf === 0) continue;
    const denom = tf + K1 * (1 - B + (B * doc.length) / (index.avgLength || 1));
    score += idf(index, term) * ((tf * (K1 + 1)) / denom);
  }
  return score;
}

/**
 * The two-stage search entry point. Filters first (`type`/`tag`/`status`/`root`, all AND'd),
 * then pins, then ranks. An empty (or whitespace-only) query returns no results rather than
 * "everything" - callers that want to browse the catalog unfiltered use `GET /knowledge`, not
 * search.
 */
export function search<T extends SearchableDocument>(
  docs: readonly T[],
  query: string,
  options: SearchOptions = {},
): SearchResult<T> {
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const offset = Math.max(0, options.offset ?? 0);
  const pinningEnabled = options.identifierPinning ?? true;

  const filtered = docs.filter((doc) => {
    if (options.type && doc.type !== options.type) return false;
    if (options.tag && !(doc.tags ?? []).includes(options.tag)) return false;
    if (options.status && doc.status !== options.status) return false;
    if (options.root && doc.root !== options.root) return false;
    return true;
  });

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return { results: [], total: 0, truncated: false };

  const bmIndex = buildBm25Index(filtered);
  // Superseded demotion, not suppression (Q5): a superseded document that is the only hit is
  // still returned, just ranked as if half as relevant.
  const effectiveScore = (doc: T): number => {
    const raw = bm25Score(bmIndex, doc.id, queryTokens);
    return doc.status === 'superseded' ? raw * SUPERSEDED_PENALTY : raw;
  };

  const pinnedIds = new Set<string>();
  if (pinningEnabled) {
    const identifierIndex = buildIdentifierIndex(filtered);
    for (const identifier of extractIdentifiers(query)) {
      for (const docId of identifierIndex.get(identifier) ?? []) pinnedIds.add(docId);
    }
  }

  const pinned: T[] = [];
  const rest: T[] = [];
  for (const doc of filtered) (pinnedIds.has(doc.id) ? pinned : rest).push(doc);

  // Deterministic tie-break by id: two consecutive identical queries must return byte-identical
  // bodies (D8), and a bare score-descending sort is not stable across engines/inputs on ties.
  const byScoreThenId = (a: T, b: T): number => {
    const diff = effectiveScore(b) - effectiveScore(a);
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };

  pinned.sort(byScoreThenId);
  // A pinned document is included regardless of its BM25 score - it may legitimately score 0
  // (the identifier lived only in frontmatter, say) and that is exactly the case the pin exists
  // to rescue. A non-pinned document with no lexical overlap at all contributes nothing.
  const restRanked = rest.filter((doc) => effectiveScore(doc) > 0).sort(byScoreThenId);

  const ordered = [...pinned, ...restRanked];
  const total = ordered.length;
  const page = ordered.slice(offset, offset + limit);
  const truncated = offset + page.length < total;

  return { results: page, total, truncated };
}
