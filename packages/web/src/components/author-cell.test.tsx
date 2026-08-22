import type { TaskAuthor } from '@loki-labs/better-cezar-api-client'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { AuthorCell, TaskLocationProvider } from '@/components/author-cell'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * The Author column's rendered half (`.ai/specs/2026-08-21-task-author-provenance.md`, Phase 4).
 *
 * The behaviour worth pinning is the LINK rule, because getting it wrong is worse than not
 * linking at all: an agent author is linked only when the page can actually say where the parent
 * lives. A parent that is off the board must render as plain text, not as a URL built from the
 * child's own project — that link would 404 while looking like a working feature.
 */

afterEach(cleanup)

const at = '2026-08-21T10:00:00.000Z'
const PARENT = '232ad6d4-58a5-421e-941f-5c24bd5a8452'

const agentAuthor: TaskAuthor = {
  kind: 'agent',
  id: PARENT,
  via: 'cli-todo-add',
  at,
  parentTaskId: PARENT,
  agentSessionId: 'cb916c71-974d-4fca-9aaa-f4c89b871b80',
}

function renderCell(author: TaskAuthor | undefined, locate?: (id: string) => string | undefined) {
  const cell = <AuthorCell author={author} />
  render(
    <MemoryRouter>
      <TooltipProvider>
        {locate ? <TaskLocationProvider locate={locate}>{cell}</TaskLocationProvider> : cell}
      </TooltipProvider>
    </MemoryRouter>,
  )
  return document.querySelector('[data-slot="task-author"]') as HTMLElement
}

describe('AuthorCell', () => {
  it('links an agent author to the parent task the page could locate', () => {
    renderCell(agentAuthor, (id) => (id === PARENT ? `/p/cezar/tasks/${id}` : undefined))
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe(`/p/cezar/tasks/${PARENT}`)
    expect(link.textContent).toBe('⤷ 232ad6d4')
  })

  it('renders the parent as PLAIN TEXT when the page cannot locate it', () => {
    // The whole point: a parent off the board (another project's store, archived away) must not
    // become a link built from a project that does not hold it.
    const el = renderCell(agentAuthor, () => undefined)
    expect(screen.queryByRole('link')).toBeNull()
    expect(el.textContent).toBe('⤷ 232ad6d4')
  })

  it('renders the parent as plain text when no provider is mounted at all', () => {
    renderCell(agentAuthor)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('never links a non-agent author, even when the id happens to resolve', () => {
    // A user's id is a userId, not a task id. Feeding it to the locator must not mint a link.
    renderCell({ kind: 'user', id: PARENT, via: 'composer', at }, (id) => `/p/cezar/tasks/${id}`)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('marks the kind and surface on the element, so a board can style or test by them', () => {
    const el = renderCell({ kind: 'api', id: 'local', via: 'composer', at })
    expect(el.dataset.authorKind).toBe('api')
    expect(el.dataset.authorVia).toBe('composer')
    expect(el.textContent).toBe('API')
  })

  it('renders an unattributed record as a dash, with its own kind marker', () => {
    const el = renderCell(undefined)
    expect(el.dataset.authorKind).toBe('none')
    expect(el.textContent).toBe('—')
  })
})
