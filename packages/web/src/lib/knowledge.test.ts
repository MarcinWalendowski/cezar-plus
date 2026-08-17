import { describe, expect, it } from 'vitest'

import type { KnowledgeDocumentList } from '@loki-labs/better-cezar-api-client'

import { filterKnowledgeDocs } from './knowledge'

const doc = (over: Partial<KnowledgeDocumentList> & Pick<KnowledgeDocumentList, 'id' | 'title' | 'updatedAt'>): KnowledgeDocumentList => ({
  slug: over.id,
  root: 'project',
  path: `/repo/.ai/cezar/knowledge/${over.id}.md`,
  type: 'note',
  tags: [],
  status: 'current',
  identifiers: [],
  hash: `hash-${over.id}`,
  bytes: 100,
  headings: [],
  excerpt: '',
  backlinkCount: 0,
  ...over,
})

describe('filterKnowledgeDocs', () => {
  it('empty query returns the full catalog sorted updatedAt desc, id tie-break', () => {
    const docs = [
      doc({ id: 'z', title: 'Z', updatedAt: '2026-01-01T00:00:00Z' }),
      doc({ id: 'a', title: 'A', updatedAt: '2026-03-01T00:00:00Z' }),
      doc({ id: 'b', title: 'B', updatedAt: '2026-01-01T00:00:00Z' }), // ties `z` — id tie-break
    ]
    expect(filterKnowledgeDocs(docs, '').map((d) => d.id)).toEqual(['a', 'b', 'z'])
  })

  it('an exact title match outranks a prefix, which outranks a substring', () => {
    const docs = [
      doc({ id: 'sub', title: 'A long title about auth flows', updatedAt: '2026-01-01T00:00:00Z' }),
      doc({ id: 'prefix', title: 'auth onboarding', updatedAt: '2026-01-01T00:00:00Z' }),
      doc({ id: 'exact', title: 'auth', updatedAt: '2026-01-01T00:00:00Z' }),
    ]
    expect(filterKnowledgeDocs(docs, 'auth').map((d) => d.id)).toEqual(['exact', 'prefix', 'sub'])
  })

  it('a title hit outranks a hit that only lands in a secondary field', () => {
    const docs = [
      doc({ id: 'title-hit', title: 'Billing overview', updatedAt: '2026-01-01T00:00:00Z' }),
      doc({ id: 'excerpt-hit', title: 'Something else', updatedAt: '2026-01-01T00:00:00Z', excerpt: 'covers billing at length' }),
    ]
    expect(filterKnowledgeDocs(docs, 'billing').map((d) => d.id)).toEqual(['title-hit', 'excerpt-hit'])
  })

  it('matches over slug, tags, domain, identifiers, headings, excerpt and type', () => {
    const bySlug = doc({ id: 'a', title: 'Untitled', slug: 'match-me', updatedAt: '2026-01-01T00:00:00Z' })
    const byTag = doc({ id: 'b', title: 'Untitled', tags: ['match-me'], updatedAt: '2026-01-01T00:00:00Z' })
    const byDomain = doc({ id: 'c', title: 'Untitled', domain: 'match-me', updatedAt: '2026-01-01T00:00:00Z' })
    const byIdentifier = doc({ id: 'd', title: 'Untitled', identifiers: ['match-me'], updatedAt: '2026-01-01T00:00:00Z' })
    const byHeading = doc({ id: 'e', title: 'Untitled', headings: ['match-me'], updatedAt: '2026-01-01T00:00:00Z' })
    const byExcerpt = doc({ id: 'f', title: 'Untitled', excerpt: 'contains match-me in prose', updatedAt: '2026-01-01T00:00:00Z' })
    const byType = doc({ id: 'g', title: 'Untitled', type: 'runbook', updatedAt: '2026-01-01T00:00:00Z' })
    const none = doc({ id: 'h', title: 'Untitled', updatedAt: '2026-01-01T00:00:00Z' })

    const hits = filterKnowledgeDocs([bySlug, byTag, byDomain, byIdentifier, byHeading, byExcerpt, none], 'match-me').map((d) => d.id)
    expect(hits.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(hits).not.toContain('h')

    expect(filterKnowledgeDocs([byType, none], 'runbook').map((d) => d.id)).toEqual(['g'])
  })

  it('every word must match somewhere — a query missing one word matches nothing', () => {
    const docs = [doc({ id: 'a', title: 'Billing overview', updatedAt: '2026-01-01T00:00:00Z' })]
    expect(filterKnowledgeDocs(docs, 'billing spaceship')).toEqual([])
    expect(filterKnowledgeDocs(docs, 'billing overview')).toEqual(docs)
  })

  it('is case-insensitive', () => {
    const docs = [doc({ id: 'a', title: 'Billing Overview', updatedAt: '2026-01-01T00:00:00Z' })]
    expect(filterKnowledgeDocs(docs, 'BILLING').map((d) => d.id)).toEqual(['a'])
  })

  it('ties within a score bucket break by updatedAt desc then id asc', () => {
    const docs = [
      doc({ id: 'older', title: 'auth', updatedAt: '2026-01-01T00:00:00Z' }),
      doc({ id: 'newer', title: 'auth', updatedAt: '2026-06-01T00:00:00Z' }),
    ]
    expect(filterKnowledgeDocs(docs, 'auth').map((d) => d.id)).toEqual(['newer', 'older'])
  })

  it('never mutates the input array', () => {
    const docs = [doc({ id: 'b', title: 'B', updatedAt: '2026-01-01T00:00:00Z' }), doc({ id: 'a', title: 'A', updatedAt: '2026-03-01T00:00:00Z' })]
    const original = [...docs]
    filterKnowledgeDocs(docs, '')
    expect(docs).toEqual(original)
  })

  // Runtime E2E round 2 (2026-08-17, real corpus, `.ai/specs/2026-08-17-knowledge-skills-
  // preview-parity.md` "fixes after runtime E2E"): typing "NECP denial" — a phrase buried only in
  // two docs' bodies, zero catalog-field hits — returned a pile of unrelated docs and never fired
  // the BM25 fallback. `matchScore`'s subsequence tier ("omfx" finds "om-fix-issue") is right-
  // sized for a skill name but, over a knowledge doc's excerpt/headings (hundreds of characters),
  // nearly any word matches SOME haystack as a subsequence — so `documentScore` almost never
  // returned 0 and the zero-hit fallback starved. Both tests below use a genuinely long,
  // ordinary-prose excerpt (not the suite's usual short fixtures) — short strings are exactly why
  // the earlier fixtures never hit this: too short for the subsequence coincidence to occur.
  it('a query word that is a subsequence, but not a substring, of a realistic long excerpt scores 0 — the fallback-starving bug', () => {
    const excerpt =
      "The onboarding runbook walks a new teammate through cloning the repository, installing " +
      "dependencies with the workspace's package manager, wiring up the required environment " +
      'variables, and finally running the local development server before opening a pull ' +
      'request for review of the finished changes, once every automated check has passed cleanly.'
    // Sanity on the fixture itself — this needs to be a genuinely long excerpt, not a token one.
    expect(excerpt.length).toBeGreaterThan(300)

    const docs = [doc({ id: 'a', title: 'Getting started', updatedAt: '2026-01-01T00:00:00Z', excerpt })]

    // "cred" is NOT a substring anywhere in the fixture (title, excerpt, or any other field) —
    // but its letters occur in that order across the excerpt (c…loning, r…epository,
    // r-e…pository, d…ependencies), which is exactly the coincidence the old subsequence tier
    // would have scored as a match. `literalMatchScore` (knowledge.ts) rejects it.
    expect(excerpt.toLowerCase()).not.toContain('cred')
    expect(filterKnowledgeDocs(docs, 'cred')).toEqual([])
  })

  it('exact, prefix, word-boundary and buried-substring hits still rank in that order, even against a long secondary haystack', () => {
    const filler =
      'Background context that pads this field out well past a couple of words, the same way a ' +
      'real excerpt or heading list would, so the ranking is proven against realistic field ' +
      'lengths rather than the short fixtures used elsewhere in this file.'
    const docs = [
      doc({ id: 'exact', title: 'auth', updatedAt: '2026-01-01T00:00:00Z', excerpt: filler }),
      doc({ id: 'prefix', title: 'auth onboarding', updatedAt: '2026-01-01T00:00:00Z', excerpt: filler }),
      doc({ id: 'word-boundary', title: 'legacy-auth flow', updatedAt: '2026-01-01T00:00:00Z', excerpt: filler }),
      doc({ id: 'buried', title: 'oauth review', updatedAt: '2026-01-01T00:00:00Z', excerpt: filler }),
    ]
    expect(filterKnowledgeDocs(docs, 'auth').map((d) => d.id)).toEqual(['exact', 'prefix', 'word-boundary', 'buried'])
  })
})
