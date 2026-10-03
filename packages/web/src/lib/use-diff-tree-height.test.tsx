import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { useDiffTreeHeight } from './use-diff-tree-height'

let mainHeight: number
let mainTop: number
let paneTop: number
let paneWidth: number
let notifyResize: () => void
let frames: Map<number, FrameRequestCallback>
let observe: Mock<ResizeObserver['observe']>
let disconnect: Mock<ResizeObserver['disconnect']>

beforeEach(() => {
  mainHeight = 864
  mainTop = 36
  paneTop = 278
  paneWidth = 240
  frames = new Map()
  observe = vi.fn<ResizeObserver['observe']>()
  disconnect = vi.fn<ResizeObserver['disconnect']>()
  notifyResize = () => {}
  let nextFrame = 0
  vi.stubGlobal('innerHeight', 900)
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
  vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      notifyResize = () => callback([], this)
    }
    observe = observe
    disconnect = disconnect
    unobserve = vi.fn()
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'MAIN' ? mainHeight : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isMain = this.tagName === 'MAIN'
    return { top: isMain ? mainTop : paneTop, bottom: isMain ? mainTop + mainHeight : paneTop + 1000,
      left: 0, right: isMain ? 1000 : paneWidth, width: isMain ? 1000 : paneWidth,
      height: isMain ? mainHeight : 1000, x: 0, y: isMain ? mainTop : paneTop,
      toJSON: () => ({}) }
  })
  document.documentElement.style.fontSize = '16px'
})

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('font-size')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function TreeFixture({ loaded = true }: { loaded?: boolean }) {
  const ref = useDiffTreeHeight()
  return (
    <main>
      <section data-testid="route">
        <header>Dynamic task header</header>
        {loaded ? <div data-testid="wrapper"><aside ref={ref} style={{ top: '160px' }}>files</aside></div> : <p>Loading…</p>}
      </section>
    </main>
  )
}

function flushFrames() {
  act(() => {
    const queued = [...frames.values()]
    frames.clear()
    for (const callback of queued) callback(0)
  })
}

const pane = () => screen.getByRole('complementary')
const height = () => pane().style.getPropertyValue('--diff-tree-height')

describe('useDiffTreeHeight', () => {
  it('bounds initial flow, sticky flow, and container-end movement without growth feedback or React commits', () => {
    const commits = vi.fn()
    render(<Profiler id="tree" onRender={commits}><TreeFixture /></Profiler>)
    const initialCommits = commits.mock.calls.length
    expect(height()).toBe('606px')
    expect(observe.mock.calls.map(([target]) => target)).toEqual([
      screen.getByRole('main'), screen.getByTestId('wrapper'), screen.getByTestId('route'),
    ])
    const writes = vi.spyOn(pane().style, 'setProperty')

    paneTop = 196
    fireEvent.scroll(screen.getByRole('main'))
    flushFrames()
    expect(height()).toBe('688px')

    paneTop = 100
    fireEvent.scroll(screen.getByRole('main'))
    notifyResize()
    flushFrames()
    expect(height()).toBe('688px')
    expect(writes).toHaveBeenCalledTimes(1)
    expect(commits.mock.calls.length).toBe(initialCommits)
  })

  it('coalesces scroll, resize and layout observations, then responds to header and viewport changes', () => {
    render(<TreeFixture />)
    mainHeight = 664
    paneTop = 196
    fireEvent.scroll(screen.getByRole('main'))
    fireEvent.resize(window)
    notifyResize()
    expect(frames.size).toBe(1)
    expect(height()).toBe('606px')
    flushFrames()
    expect(height()).toBe('488px')

    paneTop = 250
    notifyResize()
    flushFrames()
    expect(height()).toBe('434px')

    vi.stubGlobal('innerHeight', 600)
    fireEvent.resize(window)
    flushFrames()
    expect(height()).toBe('334px')
  })

  it('clamps to zero when the pane has no remaining room', () => {
    paneTop = 920
    render(<TreeFixture />)
    expect(height()).toBe('0px')
  })

  it('attaches after conditional loading and cleans up observers, listeners and pending frames', () => {
    const { rerender, unmount } = render(<TreeFixture loaded={false} />)
    expect(observe).not.toHaveBeenCalled()
    rerender(<TreeFixture />)
    expect(height()).toBe('606px')
    const main = screen.getByRole('main')
    const savedPane = pane()
    fireEvent.scroll(main)
    expect(frames.size).toBe(1)
    unmount()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(cancelAnimationFrame).toHaveBeenCalledOnce()
    expect(frames.size).toBe(0)
    expect(savedPane.style.getPropertyValue('--diff-tree-height')).toBe('')
    fireEvent.scroll(main)
    fireEvent.resize(window)
    notifyResize()
    expect(frames.size).toBe(0)
  })

  it('retains the CSS fallback for hidden or unmeasured layout, then measures when it becomes visible', () => {
    paneWidth = 0
    render(<TreeFixture />)
    expect(height()).toBe('')
    paneWidth = 240
    mainHeight = 0
    notifyResize()
    flushFrames()
    expect(height()).toBe('')
    mainHeight = 864
    notifyResize()
    flushFrames()
    expect(height()).toBe('606px')
  })

  it('measures and follows passive events when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    render(<TreeFixture />)
    expect(height()).toBe('606px')
    paneTop = 196
    fireEvent.scroll(screen.getByRole('main'))
    flushFrames()
    expect(height()).toBe('688px')
  })
})
