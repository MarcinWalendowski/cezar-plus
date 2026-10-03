import { useCallback } from 'react'

/** The sticky ceiling also bounds initial flow and container-end movement without growth feedback. */
export function useDiffTreeHeight() {
  return useCallback((pane: HTMLElement | null) => {
    const main = pane?.closest('main')
    const window = pane?.ownerDocument.defaultView
    if (!pane || !main || !window) return

    let active = true
    let frame: number | null = null
    const measure = () => {
      const mainHeight = main.clientHeight
      const paneRect = pane.getBoundingClientRect()
      if (mainHeight <= 0 || paneRect.width <= 0) return
      const stickyInset = Number.parseFloat(window.getComputedStyle(pane).top) || 0
      const gutter = Number.parseFloat(window.getComputedStyle(pane.ownerDocument.documentElement).fontSize) || 16
      const mainRect = main.getBoundingClientRect()
      const scrollportBottom = mainRect.top + main.clientTop + mainHeight
      const visibleBottom = window.innerHeight > 0 ? Math.min(scrollportBottom, window.innerHeight) : scrollportBottom
      const height = Math.max(0, Math.min(mainHeight - stickyInset - gutter, visibleBottom - paneRect.top - gutter))
      const value = `${height}px`
      if (pane.style.getPropertyValue('--diff-tree-height') !== value) {
        pane.style.setProperty('--diff-tree-height', value)
      }
    }
    const schedule = () => {
      if (!active || frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        measure()
      })
    }

    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    for (const target of new Set([main, pane.parentElement, pane.parentElement?.parentElement])) {
      if (target) observer?.observe(target)
    }
    main.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule, { passive: true })
    return () => {
      active = false
      observer?.disconnect()
      main.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (frame !== null) window.cancelAnimationFrame(frame)
      pane.style.removeProperty('--diff-tree-height')
    }
  }, [])
}
