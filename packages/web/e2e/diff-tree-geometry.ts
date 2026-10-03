import type { AgentBrowser } from './agent-browser'

export interface DiffTreeGeometry {
  rows: number
  overflow: number
  mainTop: number
  mainAfter: number
  treeTop: number
  treeMax: number
  paneTop: number
  paneBottom: number
  mainBottom: number
  lastTop: number
  lastBottom: number
}

/** Give the main and tree ResizeObservers and their coalesced frame writes time to settle. */
export function measureDiffTree(browser: AgentBrowser): DiffTreeGeometry {
  browser.evaluate(`(() => {
    window.__cezTreeGeometryReady = false
    requestAnimationFrame(() => requestAnimationFrame(() => { window.__cezTreeGeometryReady = true }))
  })()`)
  browser.waitForFunction(`window.__cezTreeGeometryReady === true`)
  return browser.evaluate(`(() => {
    const main = document.querySelector('[data-slot="main"]')
    const pane = document.querySelector('[data-slot="changes-tree-pane"]')
    if (!main || !pane) throw new Error('missing diff tree scrollport')
    const before = main.scrollTop
    pane.scrollTop = pane.scrollHeight
    const last = [...pane.querySelectorAll('[data-slot="tree-file"]')].at(-1)
    if (!last) throw new Error('missing last diff file')
    return {
      rows: pane.querySelectorAll('[data-slot="tree-file"]').length,
      overflow: pane.scrollHeight - pane.clientHeight,
      mainTop: before, mainAfter: main.scrollTop,
      treeTop: pane.scrollTop, treeMax: pane.scrollHeight - pane.clientHeight,
      paneTop: pane.getBoundingClientRect().top, paneBottom: pane.getBoundingClientRect().bottom,
      mainBottom: main.getBoundingClientRect().bottom,
      lastTop: last.getBoundingClientRect().top, lastBottom: last.getBoundingClientRect().bottom,
      main: main.getBoundingClientRect().toJSON(), pane: pane.getBoundingClientRect().toJSON(),
      stickyTop: getComputedStyle(pane).top,
      mainHeight: getComputedStyle(pane).getPropertyValue('--cez-main-height'),
      maxHeight: getComputedStyle(pane).maxHeight,
      ancestors: [pane.parentElement,pane.parentElement.parentElement].map((el) => ({
        slot:el.dataset.slot, route:el.dataset.route, top:el.getBoundingClientRect().top,
        position:getComputedStyle(el).position,
      })),
    }
  })()`) as DiffTreeGeometry
}
