import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun } from '@loki-labs/better-cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { HandoffCard } from './handoff-card'
import { resetTaskDrafts } from './task-drafts'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  resetTaskDrafts()
  localStorage.clear()
})

const handoffRun = (kind: 'manual-deploy' | 'manual-merge' = 'manual-deploy'): ApiRun =>
  ({
    id: 'handoff-1',
    title: 'ship the change',
    workflow: 'spec-to-deploy',
    task: 'Ship the change.',
    status: 'waiting',
    createdAt: '2026-08-24T12:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    pendingHandoff: {
      kind,
      stepId: kind === 'manual-deploy' ? 'deploy' : 'merge',
      requestedAt: '2026-08-24T12:00:00.000Z',
      reason: kind === 'manual-deploy' ? 'activate the cezar service' : 'land the protected base branch',
      targets: kind === 'manual-deploy' ? ['cezar service'] : undefined,
    },
  }) as ApiRun

const renderCard = (run: ApiRun) =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <HandoffCard run={run} />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )

describe('HandoffCard', () => {
  it('shows manual deployment targets and resolves the handoff', async () => {
    const requests: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push(`${init.method ?? 'GET'} ${String(input)}`)
        return new Response(JSON.stringify({ resolved: true, verdict: 'ready' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    renderCard(handoffRun())
    expect(screen.getByText('Awaiting manual deployment')).toBeTruthy()
    expect(screen.getByText('cezar service')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))

    await waitFor(() => expect(requests.some((request) => request.includes('/handoff/resolve'))).toBe(true))
  })

  it('requires a note before Skip can be used', () => {
    vi.stubGlobal('fetch', vi.fn())
    renderCard(handoffRun('manual-merge'))
    const skip = screen.getByRole('button', { name: 'Skip' }) as HTMLButtonElement
    expect(skip.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('Optional note for the handoff record'), {
      target: { value: 'protected branch handled outside cezar' },
    })
    expect(skip.disabled).toBe(false)
  })
})
