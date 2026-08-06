import { LoaderCircleIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'

/**
 * `/knowledge` loading fallback (W2.3, central-hub PLAN, package table wave 2). Same shape as
 * `skills-loading.tsx` / `git-tab-loading.tsx`: a static header plus a centered spinner, in its
 * own lightweight module that imports nothing the real shell needs (`knowledge.tsx`, which in
 * turn only lazy-loads the Markdown-heavy `document.tsx` reader once a document is actually
 * opened; see the doc block there).
 *
 * Used two ways, matching the `GitTabLoading` precedent of "doubles as X":
 *  - Directly by `KnowledgeRoute` while `useHealth()` is still in flight, i.e. before it is known
 *    whether the flag is even on. The same loading state the route would show while fetching,
 *    so nothing flashes and self-corrects.
 *  - As routes.tsx's eventual `Suspense` fallback if `KnowledgeRoute` is ever converted to a
 *    `lazy()` import there (out of scope here: `routes.tsx` is the W1.1 scaffold's chokepoint
 *    file, statically importing this route today "because today it is a tiny placeholder";
 *    see the comment beside that import).
 */
export function KnowledgeLoading() {
  return (
    <div data-route="knowledge" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Knowledge</h1>
      </header>
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title="Loading knowledge…"
        subtitle="Fetching roots, facets and the catalog."
        heading="h2"
      />
    </div>
  )
}
