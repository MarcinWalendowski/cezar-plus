import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import type { KnowledgeLink } from '@loki-labs/better-cezar-api-client'

import { BacklinksPanel, type BacklinksPanelProps } from './backlinks'

/**
 * `backlinks.tsx` (W1.10). Phases-table acceptance: "a broken link rendered rather than
 * omitted." The negative shape of that control is asserted directly: the row COUNT for a mixed
 * resolved/unresolved list must equal the input length, not just "a broken marker exists
 * somewhere" — a component that silently drops the unresolved entry would still pass a check
 * that only looked for broken markup elsewhere on the page.
 */

afterEach(cleanup)

function renderPanel(props: BacklinksPanelProps) {
  return render(
    <MemoryRouter>
      <BacklinksPanel {...props} />
    </MemoryRouter>,
  )
}

describe('BacklinksPanel — outbound', () => {
  it('renders every outbound link, resolved and unresolved alike — nothing is dropped', () => {
    const links: KnowledgeLink[] = [
      { target: 'resolved-doc', resolved: true, id: 'project-aaa' },
      { target: 'missing-doc', resolved: false, reason: 'unresolved' },
    ]
    const { container } = renderPanel({ outbound: links })
    expect(container.querySelectorAll('[data-slot="knowledge-outbound-links"] [data-slot="knowledge-link"]')).toHaveLength(2)
  })

  it('marks an unresolved link as visibly broken rather than hiding it', () => {
    const links: KnowledgeLink[] = [{ target: 'missing-doc', resolved: false, reason: 'unresolved' }]
    const { container } = renderPanel({ outbound: links })
    const row = container.querySelector('[data-slot="knowledge-link"]')!
    expect(row.getAttribute('data-resolved')).toBe('false')
    expect(row.getAttribute('data-broken')).toBe('true')
    expect(row.textContent).toContain('missing-doc')
    // A broken target never gets a working link out of it.
    expect(row.querySelector('a')).toBeNull()
  })

  it('renders an ambiguous link with its candidates, still marked broken', () => {
    const links: KnowledgeLink[] = [
      { target: 'shared-slug', resolved: false, reason: 'ambiguous', candidates: ['id-1', 'id-2'] },
    ]
    const { container } = renderPanel({ outbound: links })
    const row = container.querySelector('[data-slot="knowledge-link"]')!
    expect(row.getAttribute('data-broken')).toBe('true')
    expect(row.getAttribute('data-reason')).toBe('ambiguous')
    expect(row.textContent).toContain('id-1')
    expect(row.textContent).toContain('id-2')
  })

  it('links a resolved target when a href resolver is supplied', () => {
    const links: KnowledgeLink[] = [{ target: 'resolved-doc', resolved: true, id: 'project-aaa' }]
    const { container } = renderPanel({ outbound: links, hrefForId: (id) => `/knowledge/${id}` })
    const anchor = container.querySelector<HTMLAnchorElement>('[data-slot="knowledge-link"] a')
    expect(anchor).not.toBeNull()
    expect(anchor!.getAttribute('href')).toBe('/knowledge/project-aaa')
  })

  it('renders a resolved target as plain text, not a broken link, when no resolver is supplied', () => {
    const links: KnowledgeLink[] = [{ target: 'resolved-doc', resolved: true, id: 'project-aaa' }]
    const { container } = renderPanel({ outbound: links })
    const row = container.querySelector('[data-slot="knowledge-link"]')!
    expect(row.getAttribute('data-resolved')).toBe('true')
    expect(row.querySelector('a')).toBeNull()
  })

  it('says so plainly when there are no outbound links', () => {
    const { container } = renderPanel({ outbound: [] })
    expect(container.querySelector('[data-slot="knowledge-outbound-links"]')!.textContent).toContain(
      'links to nothing else',
    )
  })
})

describe('BacklinksPanel — inbound', () => {
  it('renders a known-zero backlink list honestly', () => {
    const { container } = renderPanel({ outbound: [], inbound: [] })
    expect(container.querySelector('[data-slot="knowledge-inbound-links"]')!.textContent).toContain(
      'No documents link here yet.',
    )
  })

  it('renders every supplied inbound entry', () => {
    const inbound = [
      { id: 'project-1', slug: 'a', title: 'Doc A' },
      { id: 'project-2', slug: 'b', title: 'Doc B' },
    ]
    const { container } = renderPanel({ outbound: [], inbound })
    expect(
      container.querySelectorAll('[data-slot="knowledge-inbound-links"] [data-slot="knowledge-link"]'),
    ).toHaveLength(2)
    expect(container.querySelector('[data-slot="knowledge-inbound-links"]')!.textContent).toContain('Doc A')
  })

  it('falls back to the count when the resolved list was not supplied', () => {
    const { container } = renderPanel({ outbound: [], backlinkCount: 3 })
    expect(container.querySelector('[data-slot="knowledge-inbound-links"]')!.textContent).toContain(
      '3 documents link here.',
    )
  })

  it('never reads absence as zero when the count itself is unknown', () => {
    const { container } = renderPanel({ outbound: [] })
    const text = container.querySelector('[data-slot="knowledge-inbound-links"]')!.textContent!
    expect(text).not.toContain('0 document')
    expect(text.toLowerCase()).toContain('not available')
  })
})
