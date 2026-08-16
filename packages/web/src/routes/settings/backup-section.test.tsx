import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BackupOverviewResponse, BackupSnapshotsResponse } from '@loki-labs/better-cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { BackupSection } from './backup-section'

/**
 * Settings → Backup (Phase 8, spec `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`):
 * the off-state (unchanged from the Phase 1 scaffold), the on-state cockpit reading the overview
 * and snapshot list, the "Back up now" mutation, and the restore confirm's fail-closed two-step
 * (N6) — the first attempt always goes out with `force:false`, and only a 409 whose `{error}`
 * names the overwrite refusal unlocks a second, distinctly-labeled retry with `force:true`.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

const OFF_OVERVIEW: BackupOverviewResponse = {
  enabled: false,
  provider: null,
  lastRun: null,
  snapshotCount: 0,
  includeSummary: null,
}

const ON_OVERVIEW: BackupOverviewResponse = {
  enabled: true,
  provider: { kind: 's3', label: 'r2: cezar-backup' },
  lastRun: {
    snapshotId: 'snap-1',
    createdAt: '2026-08-16T12:00:00.000Z',
    uploaded: 3,
    skipped: 40,
    bytes: 152_000,
  },
  snapshotCount: 2,
  includeSummary: { homeFiles: 6, projectCount: 2 },
}

const ONE_SNAPSHOT: BackupSnapshotsResponse = {
  snapshots: [{ id: 'snap-1', createdAt: '2026-08-16T12:00:00.000Z', sizeBytes: 152_000, blobCount: 43 }],
}

const REFUSAL_MESSAGE =
  '[cez] backup restore: refusing to overwrite 3 existing file(s) without force: a, b, c'

/**
 * Stubs the whole `/api/v1/backup*` family. `restoreRefusesOnce` makes the FIRST `/backup/restore`
 * call answer the fail-closed overwrite refusal (409) so the two-step confirm has something real
 * to react to; every call after that succeeds, the shape a `force:true` retry gets.
 */
function serve(
  overview: BackupOverviewResponse = OFF_OVERVIEW,
  snapshots: BackupSnapshotsResponse = { snapshots: [] },
  options: { restoreRefusesOnce?: boolean } = {},
) {
  requests = []
  let restoreCalls = 0
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })

      if (url === '/api/v1/backup' && method === 'GET') return json(overview)
      if (url === '/api/v1/backup/snapshots' && method === 'GET') return json(snapshots)
      if (url === '/api/v1/backup/run' && method === 'POST')
        return json({ snapshotId: 'snap-2', uploaded: 1, skipped: 42, bytes: 4096 })
      if (url === '/api/v1/backup/verify' && method === 'POST')
        return json({ keyOk: true, providerOk: true, sampleRoundTrip: true })
      if (url === '/api/v1/backup/gc' && method === 'POST') return json({ prunedBlobs: 2, freedBytes: 8192 })
      if (url === '/api/v1/backup/restore' && method === 'POST') {
        restoreCalls += 1
        if (options.restoreRefusesOnce && restoreCalls === 1) {
          return json({ error: REFUSAL_MESSAGE }, 409)
        }
        return json({ restored: 43, staged: 43, applied: true })
      }
      return new Promise<never>(() => {})
    }),
  )
}

function renderSection() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <BackupSection />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the backup section — off state', () => {
  it('renders "Backups are off" when the overview says disabled', async () => {
    serve()
    renderSection()
    await waitFor(() => expect(screen.getByText('Backups are off')).toBeTruthy())
  })
})

describe('the backup section — on state', () => {
  it('renders the provider, last run and snapshot list', async () => {
    serve(ON_OVERVIEW, ONE_SNAPSHOT)
    renderSection()

    await waitFor(() => expect(document.querySelector('[data-slot="backup-provider"]')).toBeTruthy())
    expect(document.querySelector('[data-slot="backup-provider"]')?.textContent).toContain('r2: cezar-backup')
    expect(document.querySelector('[data-slot="backup-last-run"]')?.textContent).toContain('snap-1')

    await waitFor(() => expect(document.querySelector('[data-slot="backup-snapshot-row"]')).toBeTruthy())
    expect(document.querySelector('[data-slot="backup-snapshot-row"]')?.textContent).toContain('snap-1')
  })

  it('an empty snapshot list renders "No snapshots yet."', async () => {
    serve(ON_OVERVIEW, { snapshots: [] })
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-slot="backup-snapshots-empty"]')).toBeTruthy())
  })

  it('"Back up now" POSTs /backup/run and renders the result', async () => {
    serve(ON_OVERVIEW, ONE_SNAPSHOT)
    renderSection()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Back up now' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }))

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/backup/run')).toBe(true),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-slot="backup-run-result"]')?.textContent).toContain('snap-2'),
    )
  })

  it('restore requires an explicit confirm before the mutation fires, and a "refusing to overwrite" refusal unlocks a distinct force retry', async () => {
    serve(ON_OVERVIEW, ONE_SNAPSHOT, { restoreRefusesOnce: true })
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-slot="backup-snapshot-row"]')).toBeTruthy())

    // Opening the dialog must never call restore by itself.
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(requests.some((r) => r.url === '/api/v1/backup/restore')).toBe(false)
    expect(document.querySelector('[data-slot="restore-dialog"]')?.textContent).toContain('Restore snapshot snap-1?')
    expect(document.querySelector('[data-slot="restore-dialog-force-confirm"]')).toBeNull()

    // First confirm: force:false.
    const firstConfirm = document.querySelector('[data-slot="restore-dialog-confirm"]') as HTMLElement
    fireEvent.click(firstConfirm)
    await waitFor(() =>
      expect(
        requests.some(
          (r) =>
            r.method === 'POST' &&
            r.url === '/api/v1/backup/restore' &&
            JSON.stringify(r.body) === JSON.stringify({ snapshotId: 'snap-1', force: false }),
        ),
      ).toBe(true),
    )

    // The refusal surfaces the server's error and swaps in the distinct, force:true confirm.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="restore-dialog-error"]')?.textContent).toContain(
        'refusing to overwrite',
      ),
    )
    const forceConfirm = document.querySelector('[data-slot="restore-dialog-force-confirm"]') as HTMLElement
    expect(forceConfirm.textContent).toContain('Overwrite existing files')
    expect(document.querySelector('[data-slot="restore-dialog-confirm"]')).toBeNull()

    // Second, explicit confirm: force:true — never sent automatically.
    fireEvent.click(forceConfirm)
    await waitFor(() =>
      expect(
        requests.some(
          (r) =>
            r.method === 'POST' &&
            r.url === '/api/v1/backup/restore' &&
            JSON.stringify(r.body) === JSON.stringify({ snapshotId: 'snap-1', force: true }),
        ),
      ).toBe(true),
    )
    expect(requests.filter((r) => r.url === '/api/v1/backup/restore').length).toBe(2)
  })
})
