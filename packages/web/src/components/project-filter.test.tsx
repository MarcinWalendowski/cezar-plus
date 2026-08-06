import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectFilter, type ProjectFilterOption } from './project-filter'

/**
 * `ProjectFilter` (W4.10, `.ai/specs/2026-08-06-workspace-notes-cross-project.md` "UI/UX" — "the
 * shared project filter"). The workspace Tasks board is its first consumer; the component itself
 * stays generic so the Notes inbox (P2.4) can reuse it unchanged.
 */

beforeEach(() => {
  // jsdom ships neither — Radix positions the dropdown with floating-ui (ResizeObserver) and the
  // shell/board queries matchMedia elsewhere; stubbing both here matches `tools-menu.test.tsx`.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(cleanup)

const OPTIONS: ProjectFilterOption[] = [
  { id: 'shop', name: 'Shop' },
  { id: 'docs', name: 'Docs' },
  { id: 'api', name: 'API' },
]

const trigger = () => screen.getByRole('button')

/** Radix opens the menu on pointerdown, not click (`tools-menu.test.tsx` precedent). */
async function openMenu(): Promise<HTMLElement> {
  fireEvent.pointerDown(trigger())
  return await screen.findByRole('menu')
}

describe('ProjectFilter', () => {
  it('labels the trigger "All projects" when selected is undefined', () => {
    render(<ProjectFilter options={OPTIONS} selected={undefined} onChange={() => {}} />)
    expect(trigger().textContent).toContain('All projects')
  })

  it('labels the trigger with the single project name when exactly one is selected', () => {
    render(<ProjectFilter options={OPTIONS} selected={['docs']} onChange={() => {}} />)
    expect(trigger().textContent).toContain('Docs')
  })

  it('labels the trigger with a count when more than one but not all are selected', () => {
    render(<ProjectFilter options={OPTIONS} selected={['docs', 'api']} onChange={() => {}} />)
    expect(trigger().textContent).toContain('2 projects')
  })

  it('labels the trigger "No projects" for an explicit empty selection', () => {
    render(<ProjectFilter options={OPTIONS} selected={[]} onChange={() => {}} />)
    expect(trigger().textContent).toContain('No projects')
  })

  it('an explicit selection covering every option reads the same as "All projects"', () => {
    render(<ProjectFilter options={OPTIONS} selected={['shop', 'docs', 'api']} onChange={() => {}} />)
    expect(trigger().textContent).toContain('All projects')
  })

  it('every option is checked when selected is undefined (ALL)', async () => {
    render(<ProjectFilter options={OPTIONS} selected={undefined} onChange={() => {}} />)
    const menu = await openMenu()
    for (const option of OPTIONS) {
      expect(within(menu).getByRole('menuitemcheckbox', { name: option.name }).getAttribute('aria-checked')).toBe('true')
    }
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'All projects' }).getAttribute('aria-checked')).toBe('true')
  })

  it('unchecking one project while ALL is active removes only that one — never collapses to it', async () => {
    const onChange = vi.fn()
    render(<ProjectFilter options={OPTIONS} selected={undefined} onChange={onChange} />)
    const menu = await openMenu()
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Docs' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(['shop', 'api'])
  })

  it('checking a project back in from a partial selection restores it, in append order', async () => {
    const onChange = vi.fn()
    render(<ProjectFilter options={OPTIONS} selected={['shop']} onChange={onChange} />)
    const menu = await openMenu()
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'API' }))
    expect(onChange).toHaveBeenCalledWith(['shop', 'api'])
  })

  it('checking every remaining project collapses the selection to undefined (ALL), not a full array', async () => {
    const onChange = vi.fn()
    render(<ProjectFilter options={OPTIONS} selected={['shop', 'docs']} onChange={onChange} />)
    const menu = await openMenu()
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'API' }))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it('clicking "All projects" resets the selection to undefined from any state', async () => {
    const onChange = vi.fn()
    render(<ProjectFilter options={OPTIONS} selected={['docs']} onChange={onChange} />)
    const menu = await openMenu()
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'All projects' }))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it('unchecking the last remaining project leaves an explicit empty selection, a real answer', async () => {
    const onChange = vi.fn()
    render(<ProjectFilter options={OPTIONS} selected={['docs']} onChange={onChange} />)
    const menu = await openMenu()
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Docs' }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('the menu stays open after toggling a project — a checklist, not a single-pick menu', async () => {
    render(<ProjectFilter options={OPTIONS} selected={undefined} onChange={() => {}} />)
    const menu = await openMenu()
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Docs' }))
    expect(screen.getByRole('menu')).toBeTruthy()
  })
})
