# Markdown code fences and mermaid diagrams render properly

Status: **Implemented** — QA Needed (see Verification).

## TLDR

Three rendering defects in the one markdown component every surface shares
(`routes/task-thread/markdown.tsx` — the thread, knowledge documents, GitHub issue bodies, skill
detail, handoffs, variant comparison):

1. **Every code fence rendered as a single line.** Newlines were absent from the DOM, not just
   from the layout.
2. **A ```mermaid fence rendered as its own source**, never as a diagram.
3. Once diagrams rendered, they came out **300px wide regardless of the diagram**.

All three are in how the app drives Streamdown 2.5.0, not in Streamdown. Fixed in
`markdown.tsx` + `styles/index.css`, with `mermaid` promoted from a borrowed transitive package to
a declared dependency of `packages/web`.

## Problem

### 1 — the fence collapse

Streamdown renders one `<span>` per token line and puts **nothing between them**:

```js
// node_modules/streamdown/dist/chunk-*.js
t.tokens.map((line, i) => jsx('span', {
  className: lineNumbers ? tr : undefined,          //  tr = 'block before:content-[counter(line)] …'
  children: line.length === 0 || (line.length === 1 && line[0].content === '')
    ? '\n'                                          //  an EMPTY line does get a newline
    : line.map(token => jsx('span', …)),            //  a non-empty one does not
}, i))
```

The only thing that separates lines is the `block` class in `tr`, and `tr` is applied **only when
line numbers are on**. This component sets `lineNumbers={false}` deliberately — a chat reply is not
a listing — so every line flowed inline. Blank lines were the sole break, which is why the failure
read as "the code block is one long line" rather than as "no line breaks at all".

Two consequences, and they need different fixes:

- **Layout.** Measured in the browser against a plain `<pre>` of the same source: 2 line boxes
  where there should be 3.
- **Text.** `code-block-body`'s `textContent` contained **no newline characters at all**, so a
  mouse selection, a screen reader and any DOM assertion all saw one line. (The copy *button* was
  fine — it copies the raw fence from Streamdown's own context, not the DOM.)

### 2 — the missing diagram

Streamdown's code renderer takes the diagram branch only when a plugin is present:

```js
if (language === 'mermaid' && diagramPlugin) { …render the diagram… }
```

`plugins` was `{ code: shikiPlugin }`. With the `mermaid` slot empty the branch falls straight
through to the code-block path **and says nothing**, so the failure is silent and looks like
"mermaid is not supported" rather than "nobody wired it up". Streamdown will not import mermaid on
our behalf: `DiagramPlugin.getMermaid` is the injection point.

### 3 — the 300px diagram

Mermaid emits `<svg width="100%" viewBox="0 0 1340 222" style="max-width: 1340px">`. Streamdown
centres it in a **shrink-to-fit flex box** (`div[role="img"].flex.justify-center`), where a
percentage width has no definite containing width to resolve against, so the browser falls back to
the SVG default — 300px, scaled by the viewBox aspect ratio to 300×50. The pan/zoom controls made
this survivable but not acceptable.

## Solution

### D1 — the newline belongs to the token, and the block belongs to the CSS

**Both**, and they are not redundant — this is written down because the pair looks like one rule
enforced twice:

- `withLineBreaks` in `markdown.tsx` appends `\n` to the last token of every non-final, non-empty
  line, exactly as Shiki's own HTML renderer does. This fixes the **text**, which is what makes it
  assertable in jsdom and what makes a mouse selection correct.
- `display: block` on the line spans in `styles/index.css` fixes the **first paint**: Streamdown
  renders its own fallback tokens (likewise unseparated) until the plugin answers, and for a real
  grammar that means until the lazy Shiki chunk lands. Without the CSS there is a visible flash of
  collapsed code on every fence.

Empty lines are skipped by `withLineBreaks` because Streamdown already renders them as a bare
newline; the predicate used is Streamdown's own, so the two cannot disagree about what "empty"
means. Measured: with either fix, with both, and with neither-but-a-plain-`<pre>`, a 3-line source
with a blank line in it occupies exactly 3 line boxes.

`withLineBreaks` lives in `markdown.tsx` and **not** in `lib/highlighter.ts`, because R5's diff
views share that singleton and lay their own lines out — a stray `\n` in the tokens would render as
content there.

### D2 — mermaid is a declared dependency, loaded lazily

`mermaid` was already in the tree as a **direct dependency of `streamdown`**, so nothing new is
installed; it is now declared in `packages/web/package.json` as well, so the import cannot break on
somebody else's dependency bump. It is reached through a dynamic `import()` inside
`DiagramPlugin.render`, which keeps it in its own chunk — a page with no diagram downloads none of
it. This is the same bundle discipline `lib/highlighter.ts` documents for Shiki.

`getMermaid` is synchronous by contract, so it returns a façade whose `render` awaits the import.

### D3 — a diagram re-renders on a theme flip

Code is highlighted once and re-themed for free, because the theme IS the `--syn-*` CSS variables.
A mermaid diagram is an SVG with baked-in colours, so it has to be re-rendered instead. Streamdown
re-runs its render effect when the `config` object's **identity** changes, so `MERMAID_DARK` /
`MERMAID_LIGHT` are module constants and the component picks between them.

The theme is read off the root element's class, **not** through `useTheme()`: this component is
rendered in places with no `ThemeProvider` above it and that hook throws, and the class is what
`applyResolvedTheme` writes — true even for the pre-paint script's stamp. One `MutationObserver`
for the whole module, shared through `useSyncExternalStore`, because a thread can hold hundreds of
messages and an observer each would be a per-message cost for a document-level fact.

### D4 — a diagram gets fullscreen and pan/zoom; a table still gets nothing

`controls.mermaid` goes from `false` to `{ copy: false, download: false, fullscreen: true,
panZoom: true }`. A diagram is the one block whose content can be genuinely unreadable at the width
of a thread column, which a scrollbar does not solve. Copy and download stay off, matching the
existing decision for code fences. `controls.table` is unchanged.

## Architecture

```
packages/web/src/routes/task-thread/markdown.tsx   withLineBreaks, mermaidPlugin, theme store
packages/web/src/styles/index.css                  line-span display, mermaid svg width
packages/web/package.json                          mermaid declared
```

No contract, server or API change. Every surface that renders markdown inherits all of this,
because they all import the one `Markdown`.

## Data Models

None. `HighlightResult` is declared by Streamdown but not exported, so it is taken from the one
place it is reachable — `NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>`.

## API Contracts

None.

## Phases

Single change; no phasing.

## Risks

- **Bundle size.** Mermaid is large (~1 MB). It is behind a dynamic import and a visibility gate,
  so it costs nothing until a diagram is actually on screen — but the published package does grow
  by that chunk.
- **Mermaid render failures.** A malformed diagram shows Streamdown's error box with the source in
  a `<details>`, which is the right failure: the content is still readable. No `errorComponent` of
  our own yet.
- **`display: block` on line spans is unguarded by any test.** jsdom has no layout, so nothing
  automated can see it. Deleting it costs a flash, not correctness — the text fix carries the
  steady state. Named here rather than papered over with a source-scanning assertion.

## Verification

Automated (`packages/web/src/routes/task-thread/markdown.test.tsx`, 26 passing), each with the
mutation that turns it red — run, not assumed:

| Guard | Mutation | Result |
|---|---|---|
| `code-block-body` text is `'first\nsecond\nthird'` | drop `withLineBreaks` from both plugin paths | red (2 failed / 26) |
| a blank line is not doubled (`'a\n\nb'`) | same | red, same run |
| a ```mermaid fence produces `mermaid-block`, not `code-block` | `plugins={{ code: shikiPlugin }}` | red (1 failed / 26) |
| a non-mermaid fence still produces `code-block` — the branch is keyed on the language | same | **stays green** (negative control) |

Test **count** held at 26 through every mutation run, so each failure is a kill and not a suite
that stopped collecting.

The mermaid test stubs `IntersectionObserver` (jsdom has none, and Streamdown's visibility gate
constructs one unconditionally — without the stub React unmounts the tree on the throw). The stub
never reports visibility on purpose: the assertion is on the diagram **branch**, not on mermaid's
own render, which needs real layout.

Gates: `npm run typecheck` clean. `npm test` — 7803 passing; 24 failures across the project-tag,
routing and onboarding suites are **pre-existing and unrelated** (they were failing before this
change and none of them touch markdown). One of the five files failing at the start of the session
*was* this session's fault — the upstream-purity brand scan, which the earlier nested-repos
docblock tripped — and it is fixed here.

Runtime, in the running cockpit at `/p/<project>/knowledge/<id>`, on a document containing a GFM
table, a `ts` fence and a mermaid flowchart:

- code fence renders on 6 lines, `code-block-body` height 218px, line span `display: block`,
  `textContent` contains newlines — measured, not eyeballed;
- the flowchart renders as an SVG at 1340×222 with pan/zoom controls and a fullscreen button;
- toggling the theme re-renders the diagram: new mermaid SVG id, dark palette marker
  (`fill:#ccc`) gone, page tokens confirmed at `--background: #ffffff`.

Still **QA Needed** rather than Done: the owner's own pass over a task thread (as opposed to a
knowledge document) has not run, and the screenshot pipeline returned a stale frame for the light
theme, so that half is confirmed by measurement only.

## Not done here

**Sortable tables.** Raised in the same conversation and worth correcting in place: Streamdown's
table controls are copy / download / fullscreen — **it has no column sorting at all**, so this is
not a switch that is turned off, it is a feature that would have to be built. Unstarted.
