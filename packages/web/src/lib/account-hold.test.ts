import { describe, expect, it } from 'vitest'

import type { RunRecord } from '@loki-labs/better-cezar-api-client'
import { queueHold, usageLimitHolds } from '@/lib/account-hold'

let seq = 0

function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'default',
    task: `task ${seq}`,
    status: 'done',
    createdAt: '2026-08-23T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

/** The production shape, 2026-08-23 (`prod-host`): a run created on codex whose pinned
 *  `review-spec` step ran on claude and hit the weekly limit. */
const limited = run({
  id: '76680e19',
  status: 'failed',
  runner: 'codex',
  agentProfile: 'default',
  autoResumeAt: '2026-08-26T23:00:30.000Z',
  steps: [
    { id: 'context', name: 'Gather', status: 'done', tokensUsed: 0, backend: 'claude', profileId: 'secondary' },
    { id: 'review-spec', name: 'Review', status: 'failed', tokensUsed: 0, backend: 'claude', profileId: 'default' },
  ] as RunRecord['steps'],
})

const NOW = Date.parse('2026-08-23T11:28:00.000Z')

describe('usageLimitHolds', () => {
  it('keys the hold on the account the failing STEP used, not the run record', () => {
    const holds = usageLimitHolds([limited], NOW)
    expect([...holds.keys()]).toEqual(['claude:default'])
  })

  it('ignores an elapsed deadline and an archived run — neither holds anything', () => {
    expect(usageLimitHolds([limited], Date.parse('2026-08-27T00:00:00.000Z')).size).toBe(0)
    expect(usageLimitHolds([{ ...limited, archived: true }], NOW).size).toBe(0)
  })

  it('keeps the SOONEST deadline when two runs hold one account', () => {
    const sooner = run({
      id: 'sooner',
      status: 'failed',
      autoResumeAt: '2026-08-24T09:00:00.000Z',
      steps: [
        { id: 'work', name: 'Work', status: 'failed', tokensUsed: 0, backend: 'claude', profileId: 'default' },
      ] as RunRecord['steps'],
    })
    const holds = usageLimitHolds([limited, sooner], NOW)
    expect(holds.get('claude:default')?.runId).toBe('sooner')
  })
})

describe('queueHold', () => {
  const holds = usageLimitHolds([limited], NOW)

  it('says nothing about a codex task while the limit is on claude', () => {
    // The whole bug, from the reader's side: this task was queued behind a Claude weekly limit
    // and the row explained nothing. With the hold keyed correctly it is not held at all.
    const queued = run({ status: 'queued', runner: 'codex' })
    expect(queueHold(queued, holds, 'claude', new Date(NOW))).toBeUndefined()
  })

  it('explains the wait for a task that really is on the held account', () => {
    const queued = run({ status: 'queued', runner: 'claude' })
    const held = queueHold(queued, holds, 'claude', new Date(NOW))
    expect(held?.title).toContain('claude:default')
    expect(held?.title).toContain('waiting out a provider usage limit')
    // Days out, so the terse pill label carries the date rather than a bare clock.
    expect(held?.label).toMatch(/Aug 2[67]/)
  })

  it('falls back to the workspace default runner, and stays silent when there is none', () => {
    const queued = run({ status: 'queued' })
    expect(queueHold(queued, holds, 'claude', new Date(NOW))?.title).toContain('claude:default')
    // No runner on the record and no default known: the account is a guess, so the row says
    // nothing rather than naming an account this task may never touch.
    expect(queueHold(queued, holds, undefined, new Date(NOW))).toBeUndefined()
  })

  it('is undefined for anything that is not a live queued run', () => {
    expect(queueHold(run({ status: 'running', runner: 'claude' }), holds, 'claude', new Date(NOW))).toBeUndefined()
    expect(
      queueHold(run({ status: 'queued', runner: 'claude', archived: true }), holds, 'claude', new Date(NOW)),
    ).toBeUndefined()
  })
})
