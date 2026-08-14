# Sortable markdown tables

Status: **Implemented** — QA Needed (see Verification).

## TLDR

Every markdown table in the cockpit sorts by column now: click a header for ascending, again for
descending, a third time to get the author's own row order back. It is built here, not switched on
— Streamdown 2.5.0 has no sorting at all, and its `controls.table` is copy / download / fullscreen.

One new component (`routes/task-thread/sortable-table.tsx`) installed as `components.table` on the
shared `Markdown`, so the thread, knowledge documents, GitHub issue bodies, skill detail, handoffs
and variant comparison all get it from the one wiring.

Corrects `2026-08-14-markdown-code-and-diagram-rendering.md` → "Not done here", which said sorting
was **unstarted**. That is now stale and marked in place.

## Problem

Knowledge documents are where the workspace's tables live — a comparison of three GraphQL
documents, a changelog, a per-project matrix — and a table you cannot reorder is read linearly, so
the column you actually came for is the one you scan by eye. Streamdown renders GFM tables
faithfully and offers nothing beyond that.

Two facts about Streamdown shape the whole design, both read out of `dist/chunk-BO2N2NFS.js`
rather than assumed:

1. **`components` is a spread over its defaults** (`{...defaults, ...userComponents}`), so
   supplying `table` **replaces** its table component. There is no merge, no wrapping — whatever
   goes in that slot owns the element.
2. **Every table sub-component is `memo`'d on a comparator that does not look at children:**

   ```js
   E = (e, t) => e.className === t.className && samePosition(e.node, t.node)
   ```

   `thead`, `tbody`, `tr`, `th`, `td` — all of them. A reorder changes only children, so the
   obvious implementation (`cloneElement(tbody, {}, reorderedRows)`) renders **once** and is then
   skipped forever. The first click sorts; every click after it does nothing, silently. This is the
   defect the feature would have shipped with, and it is invisible to any test that clicks once.

## Solution

### D1 — defeat the memo with the `key`, not by copying Streamdown's components

`cloneElement(head, { key: \`thead-${signature}\` }, …)` and the same for `tbody`, where
`signature` is `none` | `${column}-${direction}`. A different key is a different element, so React
mounts it rather than asking the comparator whether to skip it. That is the idiomatic escape and it
costs one remount per sort of a table that is already in the DOM.

The alternative was to stop using Streamdown's `thead`/`tbody`/`tr`/`th`/`td` and render our own.
Rejected: their classes would become a copy here that drifts silently on the next Streamdown
upgrade. The only markup reproduced is the outer wrapper `<div data-streamdown="table-wrapper">`,
because the component that renders it is not exported — kept attribute-for-attribute so stylesheets
and assertions that match on `data-streamdown` keep matching.

**The cells are never re-rendered.** Cell content stays the React children Streamdown produced —
bold, links, inline code, all of it — and only the ORDER of `<tr>` changes. Rebuilding cells from
the hast node would mean re-implementing inline markdown rendering.

### D2 — three sort states, because a markdown table's authored order carries meaning

asc → desc → **unsorted**. A changelog, a sequence of steps, a table ordered by importance: the row
order the author wrote is data, and a two-state toggle destroys it until a reload. The third click
restores it exactly, because sorting never mutates the row array — it derives a new one from the
original children on every render.

### D3 — the sort key comes from the hast node, not from the React tree

`hastText(cell.props.node)` walks the plain-data node react-markdown passes through (`passNode`),
so `**ORDERS_QUERY**` sorts by `ORDERS_QUERY` and `` `CART_FIELDS` `` by `CART_FIELDS`. Sorting by
the React children would mean walking elements and guessing which prop holds the text, and sorting
by raw markdown would put the backtick and the asterisk first.

Numeric columns are compared as numbers when **both** cells parse, after stripping a leading
currency symbol, a trailing `%`, and `,`/`_`/space separators: a column of `1,240` / `980` / `30`
is a number column to every reader, and as text `1,240` sorts above `30`. Everything else falls to
`localeCompare(…, { numeric: true })`, whose numeric collation already orders `SPEC-476` before
`SPEC-503` correctly.

**Blanks sort last in both directions**, forced before the direction flip. A blank cell is an
absence, not a small value, and reversing a mostly-blank column otherwise brings every blank to the
top. The sort is stable, so equal keys keep the authored order.

### D4 — focus survives the remount

The re-key is what defeats the memo, and a remount means the button the user just pressed is a
different DOM node afterwards: focus fell to `<body>` and a keyboard user was dropped out of the
table on every sort. A `refocus` ref records which header was activated and an effect keyed on
`signature` puts focus back. This is the cost of the D1 mechanism, paid here rather than left as an
accessibility bug nobody notices with a mouse.

`aria-sort` (`ascending` / `descending` / `none`) is set on the header **cell**, so the state is
announced rather than living only in the `↑` / `↓` / `↕` glyph.

### D5 — nothing to sort means no controls

A table with no `thead`, no `tbody`, no header cells, or a single body row renders exactly as it
arrived. Dead controls on a one-row table would advertise an affordance that cannot do anything.

## Architecture

```
packages/web/src/routes/task-thread/sortable-table.tsx   the component (new)
packages/web/src/routes/task-thread/markdown.tsx         BLOCK_COMPONENTS = { table: SortableTable }
```

No contract, server, API or CSS change. `inline` mode is untouched — it renders no table at all, so
it gains nothing.

## Data Models

Local state only: `SortState = { column: number; direction: 'asc' | 'desc' } | null`. Nothing is
persisted — sorting is a reading posture, not a document property, and a knowledge doc opened fresh
should read in the order it was written.

## API Contracts

None.

## Phases

Single change; no phasing.

## Risks

- **Streamdown's memo comparator is load-bearing here.** If a future version puts `children` into
  it, the `key` becomes redundant but harmless. If it stops memoizing entirely, likewise. The
  failure direction that matters — the comparator getting *stricter* — cannot break this, because a
  new key bypasses `memo` regardless.
- **The wrapper markup is a copy.** An upstream restyle of the table wrapper will not reach this
  component. Named in the file's docblock so the next upgrade sees it.
- **Column identity is positional.** A streaming table that gains a column mid-render would keep
  the sort pointed at index N, which is now a different column. Streamdown parses whole tables from
  complete markdown here (knowledge docs, finished messages), so this is theoretical today.

## Verification

Automated: `packages/web/src/routes/task-thread/sortable-table.test.tsx`, **12 tests**, all driven
through `<Markdown>` rather than by rendering `SortableTable` with hand-built props — the
component's entire job is to reorder the tree *Streamdown* produced, so a hand-built fixture would
test its own shape and would not contain the memo at all.

Mutation-tested, each mutation run and its result recorded, with the test **count** held at 12
throughout so a failure is a kill and not a suite that stopped collecting:

| Mutation | Expected kill | Result |
|---|---|---|
| M1 — drop the `key` from both `cloneElement` calls | every test past the first click | **7 failed / 12** |
| M2 — `toNumber` always returns `null` | the numeric column, and the switch-column test | **2 failed / 12** |
| M3 — `nextSort` toggles asc/desc with no third state | the authored-order restore | **1 failed / 12** |
| M4 — blanks not forced last | the blanks-in-both-directions test | **1 failed / 12** |
| M5 — remove the focus-restore effect | the focus test | **1 failed / 12** |
| restored | — | **12 passed** |

M1 is the one that matters: without the `key`, seven of twelve tests fail, which is the exact
regression a single-click test would have missed entirely.

Two of the twelve are guards against passing vacuously: the focus test asserts
`after !== before` (proving the remount really happened, so the focus assertion is about a restore
rather than about nothing having moved), and the formatting test asserts `strong` / `inline-code`
still carry their text after a sort, pinning D1's "reorder, never re-render".

Gates: `npm run typecheck` clean. `npm test` — **422 files, 7840 tests, all passing** (the 24
pre-existing failures are fixed in `2026-08-14-tag-patch-and-stale-tests.md`, same session).

Runtime, in the running cockpit at `/p/loki-labs/knowledge/workspace-53d656704cb5`, on a real
four-row knowledge table:

- 4 sort buttons rendered;
- authored `["DETAILED_ORDER_QUERY", "CART_FIELDS", "ORDERS_QUERY", "PRODUCT_FIELDS"]`;
- one click → `["CART_FIELDS", "DETAILED_ORDER_QUERY", "ORDERS_QUERY", "PRODUCT_FIELDS"]`;
- two clicks → `["PRODUCT_FIELDS", "ORDERS_QUERY", "DETAILED_ORDER_QUERY", "CART_FIELDS"]`.

A correct round trip in the real app, read back out of the DOM rather than eyeballed.

Still **QA Needed** rather than Done: the owner's own pass has not run, and the runtime check
covered a knowledge document — a table inside a live task thread (where content streams in) has not
been exercised by hand.
