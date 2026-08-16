import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import type { KnowledgeDocument } from '@loki-labs/better-cezar-api-client'

import { DocumentReader, parseCorrectionTrail } from './document'

/**
 * `document.tsx` (W1.10). Phases-table acceptance: "the superseded banner present exactly when
 * `status === 'superseded'`" — both directions are asserted, not just the positive case, per the
 * doctrine that a control only proves something when it can fail.
 */

afterEach(cleanup)

function doc(over: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: 'project-abc123',
    slug: 'example-doc',
    root: 'project',
    path: '/abs/example-doc.md',
    title: 'Example document',
    type: 'note',
    tags: [],
    status: 'current',
    identifiers: [],
    updatedAt: '2026-08-06T11:55:00Z',
    hash: 'deadbeef',
    bytes: 42,
    headings: [],
    excerpt: 'excerpt',
    links: [],
    backlinkCount: 0,
    body: 'Body text.',
    ...over,
  }
}

function renderDoc(document: KnowledgeDocument, hrefForId?: (id: string) => string) {
  return render(
    <MemoryRouter>
      <DocumentReader document={document} hrefForId={hrefForId} />
    </MemoryRouter>,
  )
}

describe('DocumentReader — superseded banner', () => {
  it('is absent for a current document', () => {
    const { container } = renderDoc(doc({ status: 'current' }))
    expect(container.querySelector('[data-slot="knowledge-superseded-banner"]')).toBeNull()
  })

  it('is absent for a draft document', () => {
    const { container } = renderDoc(doc({ status: 'draft' }))
    expect(container.querySelector('[data-slot="knowledge-superseded-banner"]')).toBeNull()
  })

  it('is present for a superseded document, naming the date', () => {
    const { container } = renderDoc(
      doc({ status: 'superseded', supersededBy: 'newer-doc', supersededAt: '2026-08-06' }),
    )
    const banner = container.querySelector('[data-slot="knowledge-superseded-banner"]')
    expect(banner).not.toBeNull()
    expect(banner!.textContent).toContain('2026-08-06')
  })

  it('links forward to the superseding document when a href resolver is supplied', () => {
    const { container } = renderDoc(
      doc({ status: 'superseded', supersededBy: 'newer-doc', supersededAt: '2026-08-06' }),
      (id) => `/knowledge/${id}`,
    )
    const link = container.querySelector<HTMLAnchorElement>('[data-slot="knowledge-superseded-link"]')
    expect(link).not.toBeNull()
    expect(link!.tagName).toBe('A')
    expect(link!.getAttribute('href')).toBe('/knowledge/newer-doc')
    expect(link!.textContent).toBe('newer-doc')
  })

  it('falls back to plain text — never a broken link — when no href resolver is supplied', () => {
    const { container } = renderDoc(
      doc({ status: 'superseded', supersededBy: 'newer-doc', supersededAt: '2026-08-06' }),
    )
    const target = container.querySelector('[data-slot="knowledge-superseded-link"]')
    expect(target).not.toBeNull()
    expect(target!.tagName).toBe('SPAN')
    expect(target!.textContent).toBe('newer-doc')
  })
})

describe('DocumentReader — correction trail', () => {
  it('renders no trail list for a single lead-in (the banner alone already covers it)', () => {
    const { container } = renderDoc(
      doc({
        status: 'superseded',
        supersededBy: 'b',
        supersededAt: '2026-08-06',
        body: '**Superseded 2026-08-06 by B Title (b).** first note\n\nOriginal body.',
      }),
    )
    expect(container.querySelector('[data-slot="knowledge-correction-trail"]')).toBeNull()
  })

  it('renders a trail entry per lead-in once a second one is present, newest first', () => {
    const { container } = renderDoc(
      doc({
        status: 'superseded',
        supersededBy: 'c',
        supersededAt: '2026-08-10',
        body:
          '**Superseded 2026-08-10 by C Title (c).** second note\n\n' +
          '**Superseded 2026-08-06 by B Title (b).** first note\n\n' +
          'Original body.',
      }),
    )
    const trail = container.querySelector('[data-slot="knowledge-correction-trail"]')
    expect(trail).not.toBeNull()
    const entries = container.querySelectorAll('[data-slot="knowledge-correction-entry"]')
    expect(entries).toHaveLength(2)
    expect(entries[0]!.textContent).toContain('C Title')
    expect(entries[1]!.textContent).toContain('B Title')
  })

  it('still renders the full body underneath — the trail summarizes, it does not replace', () => {
    const { container } = renderDoc(
      doc({
        status: 'superseded',
        supersededBy: 'c',
        supersededAt: '2026-08-10',
        body:
          '**Superseded 2026-08-10 by C Title (c).** second note\n\n' +
          '**Superseded 2026-08-06 by B Title (b).** first note\n\n' +
          'Original body text survives.',
      }),
    )
    expect(container.querySelector('[data-slot="knowledge-document-body"]')!.textContent).toContain(
      'Original body text survives.',
    )
  })
})

describe('parseCorrectionTrail', () => {
  it('stops at the first non-matching paragraph', () => {
    const body =
      '**Superseded 2026-08-10 by C Title (c).** second note\n\n' +
      'This is the original body, not a lead-in.\n\n' +
      '**Superseded 2026-08-06 by B Title (b).** should not be counted'
    expect(parseCorrectionTrail(body)).toHaveLength(1)
  })

  it('returns an empty array for an undefined or plain body', () => {
    expect(parseCorrectionTrail(undefined)).toEqual([])
    expect(parseCorrectionTrail('Just a normal document with no correction.')).toEqual([])
  })
})

describe('DocumentReader — body', () => {
  it('shows an honest placeholder when body was not loaded, rather than blank space', () => {
    const { container } = renderDoc(doc({ body: undefined }))
    expect(container.querySelector('[data-slot="knowledge-document-body"]')!.textContent).toContain(
      'no content loaded',
    )
  })
})
