import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun } from '@loki-labs/better-cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { ApprovalCard } from './approval-card'
import { readTaskDraft, resetTaskDrafts, writeTaskDraft } from './task-drafts'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  resetTaskDrafts()
  localStorage.clear()
})

const gatedRun = (extra: Partial<ApiRun> = {}): ApiRun =>
  ({
    id: 'r1',
    title: 'do the thing plz',
    workflow: 'spec-to-deploy',
    task: 'Summarize what this project does.',
    status: 'waiting',
    createdAt: '2026-07-14T12:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    pendingApproval: { minApprovers: 1, approvals: [], specPath: '.ai/specs/some-spec.md' },
    ...extra,
  }) as ApiRun

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Every request succeeds, unless `failPost` — which fails whatever the card sends, without this
 *  test having to know the project-scoped shape of the URL. */
function stubFetch({ failPost = false }: { failPost?: boolean } = {}) {
  const sent: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      sent.push(`${method} ${String(input)}`)
      if (failPost && method === 'POST') return jsonResponse({ error: 'the server said no' }, 500)
      return jsonResponse({})
    }),
  )
  return sent
}

const renderCard = (ui: ReactElement) =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        {ui}
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )

const notes = () =>
  screen.getByPlaceholderText(
    'What needs to change? These notes are handed to the spec step as its instructions.',
  ) as HTMLTextAreaElement

/**
 * The approval gate's notes are a prompt — its own placeholder says they are handed to the spec
 * step as its instructions — so they persist like the composer's draft (spec
 * `.ai/specs/2026-08-21-per-task-prompt-drafts.md`, D9). A rewind is written in paragraphs, and
 * losing them to a tab switch was the same bug in a costlier place.
 */
describe('the approval card`s notes draft', () => {
  it('paints a stored draft on the first render and persists every keystroke', () => {
    stubFetch()
    writeTaskDraft('approvalNotes', 'r1', 'the spec misses the review notes box')
    renderCard(<ApprovalCard run={gatedRun()} />)
    expect(notes().value).toBe('the spec misses the review notes box')

    fireEvent.change(notes(), { target: { value: 'and the approval one' } })
    expect(readTaskDraft('approvalNotes', 'r1')).toBe('and the approval one')
  })

  it('keeps each task`s notes apart', () => {
    stubFetch()
    renderCard(<ApprovalCard run={gatedRun()} />)
    fireEvent.change(notes(), { target: { value: 'for r1' } })
    cleanup()

    renderCard(<ApprovalCard run={gatedRun({ id: 'r2' })} />)
    expect(notes().value).toBe('')
    expect(readTaskDraft('approvalNotes', 'r1')).toBe('for r1')
  })

  it('a SUCCESSFUL request-changes clears the box AND the store', async () => {
    stubFetch()
    renderCard(<ApprovalCard run={gatedRun()} />)
    fireEvent.change(notes(), { target: { value: 'rewind and rewrite section 3' } })
    fireEvent.click(screen.getByRole('button', { name: /Request changes/ }))

    await waitFor(() => expect(notes().value).toBe(''))
    expect(localStorage.getItem('cez-task-approval-notes:r1')).toBeNull()
  })

  it('a FAILED request-changes keeps the notes in the box AND in the store', async () => {
    const sent = stubFetch({ failPost: true })
    renderCard(<ApprovalCard run={gatedRun()} />)
    fireEvent.change(notes(), { target: { value: 'a careful rewind' } })
    const requestChanges = screen.getByRole<HTMLButtonElement>('button', { name: /Request changes/ })
    fireEvent.click(requestChanges)

    // The rewind was attempted and rejected, and the button is live again.
    await waitFor(() => expect(sent.some((r) => r.startsWith('POST'))).toBe(true))
    await waitFor(() => expect(requestChanges.disabled).toBe(false))
    expect(notes().value).toBe('a careful rewind')
    expect(readTaskDraft('approvalNotes', 'r1')).toBe('a careful rewind')
  })
})
