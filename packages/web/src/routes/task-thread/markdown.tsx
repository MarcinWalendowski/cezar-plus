import { memo, useSyncExternalStore } from 'react'
import type { MermaidConfig } from 'mermaid'
import {
  Streamdown,
  defaultRemarkPlugins,
  type CodeHighlighterPlugin,
  type DiagramPlugin,
  type LinkSafetyConfig,
  type MermaidOptions,
} from 'streamdown'

import { SYN_THEME, highlight, highlightSync, supportedLanguages } from '@/lib/highlighter'

import { LinkSafetyDialog } from './link-safety-dialog'

/**
 * Assistant markdown for the thread — Streamdown (spec tech pick: stable-block memoization,
 * unterminated-block repair while streaming) with code fences highlighted by the ONE Shiki
 * singleton in `lib/highlighter.ts`.
 *
 * The seam is Streamdown's `CodeHighlighterPlugin`: without a plugin its code blocks render
 * plaintext, so the singleton is the only Shiki in the app — Streamdown 2.x core carries no
 * highlighter of its own (`@streamdown/code` is deliberately NOT installed; it would ship a
 * second Shiki). The plugin protocol is sync-when-resident / callback-when-loading, which maps
 * exactly onto `highlightSync`/`highlight`.
 *
 * Both theme slots get the one CSS-variable theme: light/dark is the `--syn-*` variables
 * flipping with the `.light` class, not two token sets.
 */
/**
 * Give every token line its trailing newline back.
 *
 * Streamdown 2.5.0 renders one `<span>` per token line with NOTHING between them, and only puts
 * `display: block` on that span when line numbers are on (its `tr` class list, `dist/chunk-*.js`).
 * We render without line numbers — a chat reply is not a listing — so every line flowed inline and
 * a fence collapsed onto one long horizontally-scrolling line, blank lines being the only break.
 * Shiki's own HTML renderer avoids this by making the newline part of the line's last token, which
 * is exactly what this does.
 *
 * It runs HERE rather than in `lib/highlighter.ts` so the shared singleton's tokens stay clean for
 * R5's diff views, which lay their own lines out and would render a stray `\n` as content.
 *
 * Two lines are deliberately left alone:
 *  - the LAST one, or the block would end with a blank line that is not in the source;
 *  - an EMPTY one — Streamdown already renders `[]` / `[{ content: '' }]` as a bare newline of its
 *    own, so a second would double-space every blank line in a fence. The predicate below is the
 *    same one Streamdown branches on.
 *
 * The companion `display: block` rule in `styles/index.css` is NOT a duplicate of this: Streamdown
 * paints its OWN fallback tokens (also one unseparated span per line) until the plugin answers,
 * which for a real grammar means until the lazy Shiki chunk lands. This fixes the text; the CSS
 * fixes that first paint.
 */
/** Streamdown declares `HighlightResult` but does not export it, so take it from the one place it
 *  is reachable — the plugin's own return type, which is the exact contract this must satisfy. */
type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>

function withLineBreaks(result: HighlightResult): HighlightResult {
  const last = result.tokens.length - 1
  return {
    ...result,
    tokens: result.tokens.map((line, index) => {
      if (index === last) return line
      if (line.length === 0 || (line.length === 1 && line[0]?.content === '')) return line
      const tail = line[line.length - 1]!
      return [...line.slice(0, -1), { ...tail, content: `${tail.content}\n` }]
    }),
  }
}

const shikiPlugin: CodeHighlighterPlugin = {
  name: 'shiki',
  type: 'code-highlighter',
  getThemes: () => [SYN_THEME, SYN_THEME],
  // The truthful list — Streamdown falls back to its plaintext body for anything else, which
  // is the required behavior for the fence infos LLMs invent (```wat, ```output, …).
  getSupportedLanguages: () => supportedLanguages() as never[],
  supportsLanguage: (language) => supportedLanguages().includes(String(language).toLowerCase()),
  highlight: ({ code, language }, callback) => {
    const resident = highlightSync(code, String(language))
    if (resident) return withLineBreaks(resident)
    void highlight(code, String(language)).then((result) => callback?.(withLineBreaks(result)))
    return null
  },
}

/**
 * Mermaid — the diagram half of the same `plugins` seam.
 *
 * Streamdown turns a ```mermaid fence into a diagram ONLY when a `DiagramPlugin` is supplied. With
 * the slot empty (what shipped until now) it falls straight through to the code-block branch and
 * says nothing, so every diagram in a knowledge document or an agent handoff rendered as its own
 * source. The library will not import mermaid on our behalf — `getMermaid` is the injection point.
 *
 * Same bundle discipline as the Shiki singleton: mermaid is reached through a dynamic `import()`
 * inside `render`, so a page with no diagram downloads none of it. `getMermaid` itself is
 * synchronous by contract, so it returns a thin façade and the awaiting happens in `render`, which
 * is async by contract. `initialize` folds into the same config rather than touching the module,
 * because the caller may configure before rendering.
 *
 * The dependency is not new to the tree — `streamdown` depends on mermaid directly — but it is
 * declared in this package's own `package.json` rather than borrowed from the hoist, so the import
 * cannot break on someone else's dependency bump.
 */
const mermaidPlugin: DiagramPlugin = {
  name: 'mermaid',
  type: 'diagram',
  language: 'mermaid',
  getMermaid: (config) => {
    let applied: MermaidConfig = { startOnLoad: false, ...config }
    return {
      initialize: (next) => {
        applied = { ...applied, ...next }
      },
      render: async (id, source) => {
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize(applied)
        return mermaid.render(id, source)
      },
    }
  },
}

/**
 * A rendered mermaid diagram is an SVG with baked-in colors, so unlike code — highlighted once and
 * re-themed by the `--syn-*` variables with zero JS — it has to be re-rendered when the palette
 * flips. Streamdown re-runs its render effect when the `config` object's IDENTITY changes, so the
 * two options objects are module constants: stable while the theme holds, different across a flip.
 */
const MERMAID_DARK: MermaidOptions = { config: { theme: 'dark' } }
const MERMAID_LIGHT: MermaidOptions = { config: { theme: 'default' } }

/**
 * Is the light palette painting right now?
 *
 * Read off the root element's class rather than through `useTheme()`, for two reasons: this
 * component is rendered in places with no `ThemeProvider` above it (and that hook throws), and the
 * class is what `applyResolvedTheme` writes, so it is true even for the pre-paint script's stamp.
 *
 * ONE observer for the whole module, shared by every mounted `Markdown` through
 * `useSyncExternalStore` — a thread can hold hundreds of messages, and an observer each would be a
 * per-message cost for a document-level fact.
 */
let rootIsLight = typeof document !== 'undefined' && document.documentElement.classList.contains('light')
const themeListeners = new Set<() => void>()
let themeObserver: MutationObserver | null = null

function subscribeRootTheme(listener: () => void): () => void {
  themeListeners.add(listener)
  if (themeObserver === null && typeof MutationObserver === 'function') {
    themeObserver = new MutationObserver(() => {
      const next = document.documentElement.classList.contains('light')
      if (next === rootIsLight) return
      rootIsLight = next
      for (const each of themeListeners) each()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
  return () => {
    themeListeners.delete(listener)
    if (themeListeners.size === 0) {
      themeObserver?.disconnect()
      themeObserver = null
    }
  }
}

const readRootTheme = (): boolean => rootIsLight

interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
}

/**
 * Turn every newline inside a text node into a hard `break` — CommonMark's "a single newline is
 * just a space" rule, disabled.
 *
 * Needed only for text a HUMAN typed (#524). An LLM writes real markdown and means the CommonMark
 * reading; a person hitting Enter in a textarea means a line break, and collapsing those would
 * reflow their message into one paragraph. `remark-breaks` does exactly this, but it is not a
 * dependency here and `unist-util-visit` is only a transitive one — an mdast tree is plain
 * objects, so the walk is cheaper to inline than either import is to take on.
 *
 * Only `text` nodes are split, which is what keeps it safe: `code` and `inlineCode` carry their
 * content in `value` with no children, so fences and spans are never touched.
 */
function remarkHardBreaks() {
  const walk = (node: MdastNode): void => {
    if (!node.children) return
    const out: MdastNode[] = []
    for (const child of node.children) {
      if (child.type === 'text' && child.value?.includes('\n')) {
        const parts = child.value.split(/\r?\n/)
        parts.forEach((part, index) => {
          // A trailing newline would otherwise emit a dangling `break`, padding every message
          // that ends in Enter with a blank line.
          if (index > 0 && !(part === '' && index === parts.length - 1)) out.push({ type: 'break' })
          if (part) out.push({ type: 'text', value: part })
        })
      } else {
        walk(child)
        out.push(child)
      }
    }
    node.children = out
  }
  return walk
}

/**
 * Streamdown's `remarkPlugins` prop REPLACES its defaults rather than extending them, so passing
 * a bare `[remarkHardBreaks]` would silently drop remark-gfm (links, tables, strikethrough, task
 * lists) and its code-meta plugin — user text would lose the very autolinking this whole change
 * exists to make consistent between the two sides. Compose onto the defaults instead.
 */
const HARD_BREAKS = [...Object.values(defaultRemarkPlugins), remarkHardBreaks]

/**
 * A compact preview still uses the real Markdown parser, but it cannot expose links or block
 * structure: ReasoningItem places an invisible collapsible trigger over this text, so a nested
 * focusable anchor would create a second control under the button. Disallowed block elements are
 * unwrapped to their text while the inline vocabulary (emphasis, strong, strike and code) stays.
 */
const INLINE_ELEMENTS = ['p', 'strong', 'em', 'del', 'code', 'a'] as const
const INLINE_COMPONENTS = { p: 'span', a: 'span' } as const

/**
 * Streamdown's link confirm, rendered by US so it portals out of the thread's contained rows —
 * see link-safety-dialog.tsx for the whole story. Module-level, not built per render: Streamdown
 * memoizes on `linkSafety` by identity, so a fresh object here would re-render every message on
 * every parent render.
 */
const LINK_SAFETY: LinkSafetyConfig = {
  enabled: true,
  renderModal: (props) => <LinkSafetyDialog {...props} />,
}

/**
 * Memoized per message (Streamdown additionally memoizes per block): during streaming only the
 * message whose `children` string actually grew re-renders — the research doc's one hard rule
 * for markdown in chat threads.
 *
 * `breaks` opts into hard line breaks — set it for user-authored text, leave it off for the
 * assistant's (see `remarkHardBreaks`).
 */
export const Markdown = memo(function Markdown({
  children,
  breaks = false,
  inline = false,
}: {
  children: string
  breaks?: boolean
  inline?: boolean
}) {
  const isLight = useSyncExternalStore(subscribeRootTheme, readRootTheme, readRootTheme)
  return (
    <Streamdown
      className={inline ? 'thread-markdown thread-markdown-inline' : 'thread-markdown'}
      plugins={{ code: shikiPlugin, mermaid: mermaidPlugin }}
      shikiTheme={[SYN_THEME, SYN_THEME]}
      mermaid={isLight ? MERMAID_LIGHT : MERMAID_DARK}
      remarkPlugins={breaks ? HARD_BREAKS : undefined}
      allowedElements={inline ? INLINE_ELEMENTS : undefined}
      unwrapDisallowed={inline || undefined}
      components={inline ? INLINE_COMPONENTS : undefined}
      linkSafety={LINK_SAFETY}
      // Copy + language chip on every fence (the deliverable); download is file-manager noise
      // in a chat, and table export dropdowns are R5-territory chrome. A diagram gets fullscreen
      // and pan/zoom instead: it is the one block whose content can be genuinely unreadable at the
      // width of a thread column, which a scrollbar does not solve.
      controls={{
        code: { copy: true, download: false },
        table: false,
        mermaid: { copy: false, download: false, fullscreen: true, panZoom: true },
      }}
      lineNumbers={false}
    >
      {children}
    </Streamdown>
  )
})
