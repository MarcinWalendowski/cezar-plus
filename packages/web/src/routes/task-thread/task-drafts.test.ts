import { afterEach, describe, expect, it, vi } from 'vitest'

import { readTaskDraft, reapTaskDrafts, resetTaskDrafts, writeTaskDraft } from './task-drafts'

afterEach(() => {
  // Unstub FIRST: a throwing `localStorage` stub would make the clear throw, abort the hook and
  // leak the stub into every test after it.
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** Seed a stored entry with an explicit stamp — `writeTaskDraft` uses `Date.now()`, and a reap
 *  test needs entries whose ages actually differ. */
const seed = (key: string, text: string, at: number) =>
  localStorage.setItem(key, JSON.stringify({ text, at }))

describe('the per-task draft store', () => {
  it('an untouched run answers the empty string', () => {
    expect(readTaskDraft('prompt', 'r1')).toBe('')
  })

  it('round-trips text for the same run and kind', () => {
    writeTaskDraft('prompt', 'r1', 'half a reply')
    expect(readTaskDraft('prompt', 'r1')).toBe('half a reply')
  })

  it('two runs never see each other`s text', () => {
    writeTaskDraft('prompt', 'r1', 'for the first task')
    writeTaskDraft('prompt', 'r2', 'for the second')
    expect(readTaskDraft('prompt', 'r1')).toBe('for the first task')
    expect(readTaskDraft('prompt', 'r2')).toBe('for the second')
  })

  it('two KINDS never see each other`s text for the same run', () => {
    writeTaskDraft('prompt', 'r1', 'a reply')
    writeTaskDraft('reviewNotes', 'r1', 'what should change')
    writeTaskDraft('approvalNotes', 'r1', 'rewind the spec')
    expect(readTaskDraft('prompt', 'r1')).toBe('a reply')
    expect(readTaskDraft('reviewNotes', 'r1')).toBe('what should change')
    expect(readTaskDraft('approvalNotes', 'r1')).toBe('rewind the spec')
  })

  it('writing empty REMOVES the key rather than storing an empty string', () => {
    writeTaskDraft('prompt', 'r1', 'typed then sent')
    writeTaskDraft('prompt', 'r1', '')
    // Asserting on the key, not on the read: a stored '' reads as '' too, and unbounded growth is
    // the whole point of the rule.
    expect(localStorage.getItem('cez-task-prompt:r1')).toBeNull()
    expect(readTaskDraft('prompt', 'r1')).toBe('')
  })

  it('a malformed stored value reads as empty and does not throw', () => {
    localStorage.setItem('cez-task-prompt:r1', '{"text": ')
    expect(readTaskDraft('prompt', 'r1')).toBe('')
  })

  it('a bare-string stored value is kept as text, never discarded', () => {
    // No version of this code writes one, but a hand-edited or legacy value is still the user's
    // words — the store does not throw them away to satisfy a schema.
    localStorage.setItem('cez-task-prompt:r1', 'words from somewhere else')
    expect(readTaskDraft('prompt', 'r1')).toBe('words from somewhere else')
  })

  it('every function survives a throwing localStorage', () => {
    const boom = () => {
      throw new Error('quota exceeded')
    }
    vi.stubGlobal('localStorage', {
      getItem: boom,
      setItem: boom,
      removeItem: boom,
      key: boom,
      get length(): number {
        throw new Error('quota exceeded')
      },
    })
    expect(() => writeTaskDraft('prompt', 'r1', 'x')).not.toThrow()
    expect(readTaskDraft('prompt', 'r1')).toBe('')
    expect(() => reapTaskDrafts()).not.toThrow()
    expect(() => resetTaskDrafts()).not.toThrow()
  })

  it('reaping 120 entries leaves the 100 NEWEST', () => {
    for (let i = 0; i < 120; i += 1) seed(`cez-task-prompt:run-${i}`, `draft ${i}`, 1_000 + i)
    reapTaskDrafts()
    const left = Object.keys(localStorage).filter((k) => k.startsWith('cez-task-prompt:'))
    expect(left).toHaveLength(100)
    // Oldest first out: run-0 … run-19 are gone, run-20 … run-119 remain.
    expect(readTaskDraft('prompt', 'run-0')).toBe('')
    expect(readTaskDraft('prompt', 'run-19')).toBe('')
    expect(readTaskDraft('prompt', 'run-20')).toBe('draft 20')
    expect(readTaskDraft('prompt', 'run-119')).toBe('draft 119')
  })

  it('reaping counts all three kinds as ONE population', () => {
    for (let i = 0; i < 60; i += 1) seed(`cez-task-prompt:run-${i}`, `p${i}`, 2_000 + i)
    for (let i = 0; i < 60; i += 1) seed(`cez-task-review-notes:run-${i}`, `n${i}`, 1_000 + i)
    reapTaskDrafts()
    const left = Object.keys(localStorage).filter((k) => k.startsWith('cez-task-'))
    expect(left).toHaveLength(100)
    // The review notes are the older half, so they are what goes.
    expect(readTaskDraft('reviewNotes', 'run-0')).toBe('')
    expect(readTaskDraft('prompt', 'run-59')).toBe('p59')
  })

  it('reaping never touches a key this store did not write', () => {
    localStorage.setItem('cez-theme', 'dark')
    localStorage.setItem('cez-new-task-draft', '{"text":"a task"}')
    localStorage.setItem('cez-followup-prompt:https://x/1', 'a hand-off')
    for (let i = 0; i < 120; i += 1) seed(`cez-task-prompt:run-${i}`, `draft ${i}`, 1_000 + i)
    reapTaskDrafts()
    expect(localStorage.getItem('cez-theme')).toBe('dark')
    expect(localStorage.getItem('cez-new-task-draft')).toBe('{"text":"a task"}')
    expect(localStorage.getItem('cez-followup-prompt:https://x/1')).toBe('a hand-off')
  })

  it('a store under the cap is left alone', () => {
    for (let i = 0; i < 100; i += 1) seed(`cez-task-prompt:run-${i}`, `draft ${i}`, 1_000 + i)
    reapTaskDrafts()
    expect(Object.keys(localStorage)).toHaveLength(100)
  })

  it('reset clears the store`s own keys and nothing else', () => {
    localStorage.setItem('cez-theme', 'dark')
    writeTaskDraft('prompt', 'r1', 'x')
    writeTaskDraft('approvalNotes', 'r2', 'y')
    resetTaskDrafts()
    expect(readTaskDraft('prompt', 'r1')).toBe('')
    expect(readTaskDraft('approvalNotes', 'r2')).toBe('')
    expect(localStorage.getItem('cez-theme')).toBe('dark')
  })
})
