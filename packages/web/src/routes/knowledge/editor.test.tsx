import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DocumentEditor } from './editor'

/**
 * `editor.tsx` (W1.10). Phases-table acceptance: "409 message rendered verbatim and the edit
 * preserved." Both halves get their own control below, plus the `version` contract the spec
 * calls out by name ("sends `version`").
 */

afterEach(cleanup)

const baseDoc = { id: 'project-abc', title: 'Doc', body: 'Original content', hash: 'sha-1' }

describe('DocumentEditor — save', () => {
  it('sends the loaded document.hash as version with every save', () => {
    const onSave = vi.fn()
    const { getByLabelText, getByRole } = render(<DocumentEditor document={baseDoc} writable onSave={onSave} />)

    fireEvent.change(getByLabelText('Doc content'), { target: { value: 'Edited content' } })
    fireEvent.click(getByRole('button', { name: 'Save' }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith({ content: 'Edited content', version: 'sha-1' })
  })

  it('disables Save until the draft actually differs from the loaded content', () => {
    const { getByRole } = render(<DocumentEditor document={baseDoc} writable onSave={vi.fn()} />)
    expect((getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('DocumentEditor — 409 conflict', () => {
  it('renders the server message VERBATIM — no paraphrase, no wrapping text added', () => {
    const serverMessage = 'Version mismatch: someone else saved this document at 2026-08-06T12:00:00Z.'
    const { container } = render(
      <DocumentEditor
        document={baseDoc}
        writable
        onSave={vi.fn()}
        error={{ status: 409, message: serverMessage }}
      />,
    )
    const banner = container.querySelector('[data-slot="knowledge-editor-error"]')
    expect(banner).not.toBeNull()
    // Exact equality, not `toContain` — a generic "Conflict:" prefix or a reworded message would
    // both still "contain" pieces of the original and would wrongly pass a looser check.
    expect(banner!.textContent).toBe(serverMessage)
  })

  it('renders whatever different message a different 409 carries — nothing is templated', () => {
    const otherMessage = 'This root is read-only.'
    const { container } = render(
      <DocumentEditor document={baseDoc} writable onSave={vi.fn()} error={{ status: 409, message: otherMessage }} />,
    )
    expect(container.querySelector('[data-slot="knowledge-editor-error"]')!.textContent).toBe(otherMessage)
  })

  it('never discards the user’s in-progress edit when a conflict arrives', () => {
    const { getByLabelText, rerender } = render(<DocumentEditor document={baseDoc} writable onSave={vi.fn()} />)
    const textarea = getByLabelText('Doc content') as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: 'My in-progress edit' } })
    expect(textarea.value).toBe('My in-progress edit')

    // The save the user just attempted comes back 409 — the draft must survive untouched.
    rerender(
      <DocumentEditor
        document={baseDoc}
        writable
        onSave={vi.fn()}
        error={{ status: 409, message: 'stale version' }}
      />,
    )
    expect((getByLabelText('Doc content') as HTMLTextAreaElement).value).toBe('My in-progress edit')
  })

  it('does not reset the draft while `saving` is true either', () => {
    const { getByLabelText, rerender } = render(<DocumentEditor document={baseDoc} writable onSave={vi.fn()} />)
    const textarea = getByLabelText('Doc content') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Mid-save edit' } })

    rerender(<DocumentEditor document={baseDoc} writable onSave={vi.fn()} saving />)
    expect((getByLabelText('Doc content') as HTMLTextAreaElement).value).toBe('Mid-save edit')
  })
})

describe('DocumentEditor — read-only', () => {
  it('shows the content read-only without a Save control', () => {
    const { getByLabelText, queryByRole } = render(
      <DocumentEditor document={baseDoc} writable={false} onSave={vi.fn()} />,
    )
    const textarea = getByLabelText('Doc content') as HTMLTextAreaElement
    expect(textarea.value).toBe('Original content')
    expect(textarea.readOnly).toBe(true)
    expect(queryByRole('button', { name: 'Save' })).toBeNull()
  })
})

describe('DocumentEditor — document identity', () => {
  it('re-seeds the draft when a different document loads', () => {
    const { getByLabelText, rerender } = render(<DocumentEditor document={baseDoc} writable onSave={vi.fn()} />)
    fireEvent.change(getByLabelText('Doc content'), { target: { value: 'Unsaved local edit' } })

    const other = { id: 'project-def', title: 'Other', body: 'Fresh content', hash: 'sha-2' }
    rerender(<DocumentEditor document={other} writable onSave={vi.fn()} />)

    expect((getByLabelText('Other content') as HTMLTextAreaElement).value).toBe('Fresh content')
  })
})
