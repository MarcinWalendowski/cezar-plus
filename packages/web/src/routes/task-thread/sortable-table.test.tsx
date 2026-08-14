import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Markdown } from './markdown'

afterEach(cleanup)

/**
 * Click-to-sort on markdown tables (`sortable-table.tsx`). Driven through `Markdown` rather than by
 * rendering `SortableTable` with hand-built props: the component's whole job is to reorder the
 * element tree STREAMDOWN produced, so a hand-built tree would be testing a fixture's shape rather
 * than the integration — including the memo comparator that made the naive version update once and
 * then never again.
 */

const TABLE = [
  '| Document | Lines | Fixed in |',
  '| --- | --- | --- |',
  '| `CART_FIELDS` | 1,240 | SPEC-478 |',
  '| **ORDERS_QUERY** | 980 | SPEC-503 |',
  '| DETAILED_ORDER | 30 | SPEC-476 |',
].join('\n')

/** The first cell of every body row, top to bottom — what a sort actually changes. */
function firstColumn(): string[] {
  return [...document.querySelectorAll('[data-streamdown="table-body"] tr')].map(
    (row) => row.querySelector('td')?.textContent?.trim() ?? '',
  )
}

function header(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) })
}

describe('sortable markdown tables', () => {
  it('renders the table unsorted, in the order the markdown wrote it', () => {
    render(<Markdown>{TABLE}</Markdown>)
    expect(firstColumn()).toEqual(['CART_FIELDS', 'ORDERS_QUERY', 'DETAILED_ORDER'])
    expect(document.querySelector('[data-streamdown="table-wrapper"]')).not.toBeNull()
    expect(document.querySelectorAll('[data-slot="table-sort"]')).toHaveLength(3)
  })

  it('sorts ascending on the first click, by the cell TEXT and not by its markup', () => {
    render(<Markdown>{TABLE}</Markdown>)
    fireEvent.click(header('Document'))
    // `**ORDERS_QUERY**` and `` `CART_FIELDS` `` must sort as their text — by their markup the
    // backtick and the asterisk would lead.
    expect(firstColumn()).toEqual(['CART_FIELDS', 'DETAILED_ORDER', 'ORDERS_QUERY'])
  })

  /**
   * The regression the `key` exists for: every Streamdown table sub-component is memoized on
   * `className` + node position, with `children` NOT in the comparator, so reordered children alone
   * render once and are then skipped forever. Without it this second click is a no-op.
   */
  it('reverses on the second click — the memo must not swallow the update', () => {
    render(<Markdown>{TABLE}</Markdown>)
    fireEvent.click(header('Document'))
    fireEvent.click(header('Document'))
    expect(firstColumn()).toEqual(['ORDERS_QUERY', 'DETAILED_ORDER', 'CART_FIELDS'])
  })

  it('returns to the authored order on the third click', () => {
    render(<Markdown>{TABLE}</Markdown>)
    // Re-queried on every click on purpose: sorting re-keys `thead`, so the previous button is
    // detached and clicking the stale handle would silently do nothing.
    fireEvent.click(header('Document'))
    fireEvent.click(header('Document'))
    fireEvent.click(header('Document'))
    expect(firstColumn()).toEqual(['CART_FIELDS', 'ORDERS_QUERY', 'DETAILED_ORDER'])
  })

  /** The other half of that re-key: the button the user pressed is a NEW node afterwards, so
   *  without the restore a keyboard user is dropped to `<body>` on every sort. */
  it('keeps focus on the header that was activated, across the remount', () => {
    render(<Markdown>{TABLE}</Markdown>)
    const before = header('Lines')
    before.focus()
    fireEvent.click(before)

    const after = header('Lines')
    expect(after).not.toBe(before) // the remount really happened — otherwise this proves nothing
    expect(document.activeElement).toBe(after)
  })

  it('sorts a numeric column numerically, thousands separator and all', () => {
    render(<Markdown>{TABLE}</Markdown>)
    fireEvent.click(header('Lines'))
    // As text this is 1,240 < 30 < 980 — the whole reason the column is parsed rather than compared.
    expect(firstColumn()).toEqual(['DETAILED_ORDER', 'ORDERS_QUERY', 'CART_FIELDS'])
  })

  it('switching column starts that column ascending rather than inheriting the direction', () => {
    render(<Markdown>{TABLE}</Markdown>)
    fireEvent.click(header('Document'))
    fireEvent.click(header('Document')) // Document is now descending
    fireEvent.click(header('Lines'))
    expect(firstColumn()).toEqual(['DETAILED_ORDER', 'ORDERS_QUERY', 'CART_FIELDS'])
  })

  it('announces the sort on the header cell, not only in the arrow', () => {
    render(<Markdown>{TABLE}</Markdown>)
    const cells = () =>
      [...document.querySelectorAll('[data-streamdown="table-header-cell"]')].map((cell) =>
        cell.getAttribute('aria-sort'),
      )
    expect(cells()).toEqual(['none', 'none', 'none'])
    fireEvent.click(header('Document'))
    expect(cells()).toEqual(['ascending', 'none', 'none'])
    fireEvent.click(header('Document'))
    expect(cells()).toEqual(['descending', 'none', 'none'])
  })

  it('sorts blank cells last in BOTH directions', () => {
    render(
      <Markdown>
        {['| Name | Owner |', '| --- | --- |', '| a | zoe |', '| b |  |', '| c | amy |'].join('\n')}
      </Markdown>,
    )
    fireEvent.click(header('Owner'))
    expect(firstColumn()).toEqual(['c', 'a', 'b'])
    fireEvent.click(header('Owner'))
    expect(firstColumn()).toEqual(['a', 'c', 'b'])
  })

  it('leaves a one-row table alone — no controls where there is nothing to order', () => {
    render(<Markdown>{['| Key | Value |', '| --- | --- |', '| only | row |'].join('\n')}</Markdown>)
    expect(document.querySelector('[data-streamdown="table"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="table-sort"]')).toBeNull()
  })

  it('keeps cell formatting intact through a sort — it reorders rows, it does not re-render cells', () => {
    render(<Markdown>{TABLE}</Markdown>)
    fireEvent.click(header('Document'))
    expect(document.querySelector('[data-streamdown="table-body"] [data-streamdown="strong"]')?.textContent).toBe(
      'ORDERS_QUERY',
    )
    expect(document.querySelector('[data-streamdown="table-body"] [data-streamdown="inline-code"]')?.textContent).toBe(
      'CART_FIELDS',
    )
  })

  it('inline mode has no table at all, so it gains no controls', () => {
    render(<Markdown inline>{TABLE}</Markdown>)
    expect(document.querySelector('table')).toBeNull()
    expect(document.querySelector('[data-slot="table-sort"]')).toBeNull()
  })
})
