import { LoaderCircleIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'

/**
 * The `/todos/:todoId` Suspense fallback (routes.tsx) AND the route's own `loading` data state
 * (`query.isPending`, before `useWorkspaceTodos()` settles) — a SEPARATE lightweight module, on
 * purpose, so importing it as a Suspense fallback does not pull `filed-task-detail.tsx`'s markdown
 * chunk into the main bundle. Mirrors `thread-loading.tsx`/`skills-loading.tsx`.
 *
 * Carries both `data-route` and `data-slot="filed-task-detail"` — the same pair every one of this
 * page's five states carries, so `routes.test.tsx`'s registration case and every existing
 * `[data-slot="filed-task-detail"]` selector resolve regardless of which state rendered.
 */
export function FiledTaskDetailLoading() {
  return (
    <div data-route="filed-task-detail" data-slot="filed-task-detail" className="flex min-h-full flex-col">
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title="Loading task…"
        subtitle="Fetching the filed task."
      />
    </div>
  )
}
