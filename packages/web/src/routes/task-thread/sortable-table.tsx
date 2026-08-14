import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'

/**
 * Click-to-sort for every markdown table in the cockpit.
 *
 * Streamdown renders GFM tables but does **not** sort them — its `controls.table` is copy /
 * download / fullscreen, nothing more — so this is the sorting, not a switch turned on. It is
 * installed as `components.table`, which REPLACES Streamdown's own table component (its `components`
 * prop is a spread over its defaults, not a merge into them).
 *
 * ## Two things this deliberately does not do
 *
 * **It does not re-render the cells.** Cell content stays the React children Streamdown produced —
 * bold, links, inline code and all — and only the ORDER of the `<tr>` elements changes. Rebuilding
 * cells from the hast node would mean re-implementing inline markdown rendering.
 *
 * **It does not restyle the rows.** `thead`, `tbody`, `tr` and `th` are Streamdown's own components,
 * reached with `cloneElement`, so their classes stay Streamdown's problem rather than becoming a
 * copy here that drifts on the next upgrade. Only the outer wrapper is reproduced, because the
 * component that renders it (`MarkdownTable` → its wrapper) is not exported.
 *
 * ## Why `key` and not just new children
 *
 * Every one of those sub-components is `memo`'d on a comparator that reads **`className` and the
 * node's source position only** — `children` is not in it (`dist/chunk-*.js`: `E = (e, t) =>
 * e.className === t.className && samePosition(e.node, t.node)`). So `cloneElement(tbody, {},
 * reorderedRows)` renders once and then never updates: the second click would change nothing at
 * all, silently. Changing the `key` sidesteps the comparator the idiomatic way — a different key is
 * a different element, so React mounts it instead of asking whether to skip it.
 */

interface HastNode {
  type: string
  tagName?: string
  value?: string
  children?: HastNode[]
}

type MarkdownElement = ReactElement<{ node?: HastNode; children?: ReactNode; className?: string }>

type SortDirection = 'asc' | 'desc'
interface SortState {
  column: number
  direction: SortDirection
}

/** The rendered text of a hast subtree — the sort key. Taken from the NODE rather than from the
 *  React children because the node is plain data: no element walking, no guessing which prop holds
 *  the text, and `**bold**` sorts by `bold` rather than by its markup. */
function hastText(node: HastNode | undefined): string {
  if (node === undefined) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastText).join('')
}

function elementChildren(element: MarkdownElement | undefined): MarkdownElement[] {
  if (element === undefined) return []
  return Children.toArray(element.props.children).filter(isValidElement) as MarkdownElement[]
}

function tagOf(element: MarkdownElement): string | undefined {
  return element.props.node?.tagName
}

/**
 * A cell's value as a number, or null when it is not one.
 *
 * Thousands separators, a leading currency symbol and a trailing `%` are stripped first: a column
 * of `1,240` / `980` is a number column to every reader, and comparing it as text puts `980` above
 * `1,240`. Anything else — `SPEC-476`, `yes`, `2026-08-14` — stays text, where `localeCompare`'s
 * numeric collation already orders embedded digits correctly.
 */
function toNumber(value: string): number | null {
  const cleaned = value.trim().replace(/^[$€£¥]/, '').replace(/%$/, '').replace(/[\s,_]/g, '')
  if (cleaned === '') return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

/** Empty cells sort last in BOTH directions — handled before the direction flip, because "blank"
 *  is an absence rather than a small value, and a column of mostly-blank rows is unreadable when
 *  reversing brings every blank to the top. */
function compareCells(a: string, b: string): number {
  const left = toNumber(a)
  const right = toNumber(b)
  if (left !== null && right !== null) return left - right
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

export function sortRows(rows: MarkdownElement[], sort: SortState | null): MarkdownElement[] {
  if (sort === null) return rows
  const keyed = rows.map((row) => {
    const cells = elementChildren(row)
    return { row, key: hastText(cells[sort.column]?.props.node).trim() }
  })
  // `sort` is stable, so rows with equal keys keep the order the author wrote them in.
  keyed.sort((a, b) => {
    if (a.key === '' && b.key === '') return 0
    if (a.key === '') return 1
    if (b.key === '') return -1
    const result = compareCells(a.key, b.key)
    return sort.direction === 'asc' ? result : -result
  })
  return keyed.map((entry) => entry.row)
}

/** asc → desc → unsorted. The third state is the point: a markdown table's own row order often
 *  carries meaning (a changelog, a sequence of steps), so sorting must be undoable without a
 *  reload. */
function nextSort(current: SortState | null, column: number): SortState | null {
  if (current === null || current.column !== column) return { column, direction: 'asc' }
  if (current.direction === 'asc') return { column, direction: 'desc' }
  return null
}

const ARROW: Record<SortDirection, string> = { asc: '↑', desc: '↓' }

export function SortableTable({ children, className }: { children?: ReactNode; className?: string }) {
  const [sort, setSort] = useState<SortState | null>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  /** Which header was just activated, so focus can be put back after the re-key remounts it. */
  const refocus = useRef<number | null>(null)

  const sections = Children.toArray(children).filter(isValidElement) as MarkdownElement[]
  const head = sections.find((section) => tagOf(section) === 'thead')
  const body = sections.find((section) => tagOf(section) === 'tbody')
  const headerRow = elementChildren(head)[0]
  const headerCells = elementChildren(headerRow)
  const rows = elementChildren(body)

  // Nothing to sort: a table with no header, no body, or a single row. Rendered exactly as it
  // arrived rather than with dead controls on it.
  const sortable = head !== undefined && body !== undefined && headerCells.length > 0 && rows.length > 1

  const signature = sort === null ? 'none' : `${sort.column}-${sort.direction}`

  /**
   * Put focus back on the header that was just activated.
   *
   * Re-keying `thead` is what defeats the memo, and a re-key is a remount: the button the user
   * clicked is a different DOM node afterwards, so focus fell to `<body>` and a keyboard user was
   * dropped out of the table on every sort. Restoring it is the cost of the mechanism, paid here
   * rather than left as an accessibility bug nobody would notice with a mouse.
   */
  useEffect(() => {
    const index = refocus.current
    if (index === null) return
    refocus.current = null
    const buttons = tableRef.current?.querySelectorAll<HTMLButtonElement>('[data-slot="table-sort"]')
    buttons?.[index]?.focus()
  }, [signature])

  const decoratedHead =
    sortable && headerRow !== undefined && head !== undefined
      ? cloneElement(
          head,
          { key: `thead-${signature}` },
          cloneElement(
            headerRow,
            {},
            headerCells.map((cell, index) =>
              cloneElement(
                cell,
                {
                  key: `th-${index}`,
                  'aria-sort':
                    sort?.column === index ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none',
                } as Record<string, unknown>,
                <button
                  type="button"
                  data-slot="table-sort"
                  data-direction={sort?.column === index ? sort.direction : undefined}
                  className="inline-flex items-center gap-1 text-left font-semibold hover:text-foreground"
                  onClick={() => {
                    refocus.current = index
                    setSort((current) => nextSort(current, index))
                  }}
                >
                  {cell.props.children}
                  <span aria-hidden="true" className="text-soft-foreground">
                    {sort?.column === index ? ARROW[sort.direction] : '↕'}
                  </span>
                </button>,
              ),
            ),
          ),
        )
      : head

  const sortedBody =
    sortable && body !== undefined
      ? cloneElement(body, { key: `tbody-${signature}` }, sortRows(rows, sort))
      : body

  // The one piece of Streamdown markup reproduced rather than reused: its table wrapper lives in a
  // component it does not export. Kept attribute-for-attribute so stylesheets and assertions that
  // match on `data-streamdown` keep matching.
  return (
    <div
      className="my-4 flex flex-col gap-2 rounded-lg border border-border bg-sidebar p-2"
      data-streamdown="table-wrapper"
    >
      <div className="border-collapse overflow-x-auto overflow-y-auto rounded-md border border-border bg-background">
        <table
          ref={tableRef}
          className={`w-full divide-y divide-border${className ? ` ${className}` : ''}`}
          data-streamdown="table"
        >
          {decoratedHead}
          {sortedBody}
        </table>
      </div>
    </div>
  )
}
