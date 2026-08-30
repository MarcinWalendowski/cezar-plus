import type { KnowledgeDocumentList } from '@loki-labs/cezar-plus-api-client'

import { matchScore } from './skills'

/**
 * The Knowledge page's client-side catalog filter (skills-preview parity,
 * `.ai/specs/2026-08-17-knowledge-skills-preview-parity.md`) — a pure, un-debounced narrowing
 * function over the full `GET /knowledge/documents` catalog, mirroring `lib/skills.ts`'s ranked
 * scoring (exact > prefix > word-boundary > substring > subsequence, via {@link matchScore}) so
 * the Knowledge and Skills pages feel like one filter. No fetch happens inside this module —
 * `knowledge.tsx` calls it against data it already has, per keystroke.
 *
 * Matched fields, per the spec: `title`, `slug`, `tags`, `domain`, `identifiers`, `headings`,
 * `excerpt`, `type`. A title hit is boosted over a hit anywhere else — the same "name outranks
 * description" shape `queryScore` (skills.ts) uses — so an (almost-)exact title match always
 * sorts to the top of a query that also happens to appear in, say, an excerpt.
 *
 * Deterministic order: score descending, then `updatedAt` descending, then `id` ascending. An
 * empty query is not "no filter, incoming order" like `lib/skills.ts`'s pickers — the spec calls
 * for "full catalog sorted `updatedAt` desc, `id` tie-break" explicitly, so the sort applies on
 * the empty-query path too (the server already answers `GET /knowledge/documents` in that same
 * order, but this function does not trust the caller not to have reshuffled it via facet
 * filtering first).
 *
 * **Deliberately NOT `matchScore`'s full tier range.** `matchScore`'s bottom tier is a
 * case-insensitive SUBSEQUENCE match ("omfx" finds "om-fix-issue") — right-sized for a skill
 * name (a handful of characters), but over a knowledge document's secondary haystack (excerpt +
 * headings can run hundreds of characters) nearly any short word matches SOME haystack as a
 * subsequence, so a query would almost never score 0. That starves the zero-hit BM25 fallback in
 * `knowledge.tsx`, which only fires when the client-side filter finds nothing — confirmed against
 * the real corpus (2026-08-17 runtime E2E round 2): "NECP denial", a phrase that appears only
 * deep in two docs' bodies, matched a pile of unrelated docs by subsequence coincidence and never
 * triggered a search request. {@link literalMatchScore} gates `matchScore` behind an explicit
 * substring check instead of trusting its return value, so a hit here is always a literal one
 * (exact / prefix / word-boundary / buried substring) — never a subsequence coincidence.
 */

/** A title hit outranks a hit in any other field by this much — mirrors `queryScore`'s
 *  `NAME_MATCH_BONUS` (skills.ts), which is well clear of `matchScore`'s 0-6 range. */
const TITLE_MATCH_BONUS = 10

/** Every non-title field the spec lists, folded into one haystack `matchScore` scans as a
 *  substring/word-boundary target. Array fields join on a space, which doubles as a word
 *  boundary — a tag search for "auth" correctly does not bleed into a neighbouring tag. */
function secondaryHaystack(doc: KnowledgeDocumentList): string {
  return [doc.slug, doc.tags.join(' '), doc.domain, doc.identifiers.join(' '), doc.headings.join(' '), doc.excerpt, doc.type]
    .filter((part): part is string => Boolean(part))
    .join(' ')
}

/** `matchScore`, but rejects its subsequence-only tier — a hit only counts when `word` is
 *  actually a substring of `haystack` (matchScore's exact/prefix/word-boundary/buried-substring
 *  tiers all imply this; only its lowest, fuzzy-subsequence tier does not). Gated on the literal
 *  substring check rather than a hardcoded score threshold, so this stays honest about "a literal
 *  hit, or nothing" without needing to know `matchScore`'s internal tier numbers — see the module
 *  doc comment for why the subsequence tier is wrong here even though it's right for `skills.ts`. */
function literalMatchScore(haystack: string, word: string): number {
  return haystack.toLowerCase().includes(word.toLowerCase()) ? matchScore(haystack, word) : 0
}

/** How well one document matches a (non-empty, already-trimmed) query: every whitespace-split
 *  word must match somewhere (title OR the secondary fields) or the document scores 0 — the same
 *  "every word must match" rule `queryScore` enforces, just over more fields than name+description. */
function documentScore(doc: KnowledgeDocumentList, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 1
  const secondary = secondaryHaystack(doc)
  let total = 0
  for (const word of words) {
    const titleScore = literalMatchScore(doc.title, word)
    const secondaryScore = literalMatchScore(secondary, word)
    if (titleScore === 0 && secondaryScore === 0) return 0
    total += titleScore > 0 ? titleScore + TITLE_MATCH_BONUS : secondaryScore
  }
  return total
}

/** `updatedAt` desc, `id` asc — the tie-break the spec names, and the server's own
 *  `GET /knowledge/documents` ordering (`knowledge-routes.ts`), so the two agree byte-for-byte
 *  whenever no filter is narrowing the list. */
function byRecency(a: KnowledgeDocumentList, b: KnowledgeDocumentList): number {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
}

/** Filter+rank the knowledge catalog for a typed query. Pure and synchronous — no fetch, no
 *  debounce; `knowledge.tsx` runs it on every keystroke and falls back to server BM25 search only
 *  when this returns zero hits for a non-empty query. */
export function filterKnowledgeDocs<T extends KnowledgeDocumentList>(docs: readonly T[], query: string): T[] {
  const trimmed = query.trim()
  if (trimmed === '') return [...docs].sort(byRecency)
  return docs
    .map((doc) => ({ doc, score: documentScore(doc, trimmed) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || byRecency(a.doc, b.doc))
    .map((entry) => entry.doc)
}
