import { cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { ProjectScopeProvider, useProjectScope } from './project-scope-context'
import { getApiScope, queryScope, apiPath, setApiScope } from '@loki-labs/better-cezar-api-client'

afterEach(() => {
  cleanup()
  setApiScope(null)
})

/** Reads everything a scoped child would: the context AND the module seam, during render —
 *  exactly when queries.ts computes keys and client calls fire from event handlers. */
function Probe() {
  const { projectId, apiBase } = useProjectScope()
  return (
    <output data-testid="probe">
      {`${projectId ?? '-'}|${apiBase}|${queryScope()}|${apiPath('/runs')}`}
    </output>
  )
}

describe('ProjectScopeProvider', () => {
  it('defaults to unscoped outside any provider — no project prefix, just the version', () => {
    const view = render(<Probe />)
    expect(view.getByTestId('probe').textContent).toBe('-|/api/v1|default|/api/v1/runs')
  })

  it('scopes both the context and the module seam before the children render', () => {
    const view = render(
      <ProjectScopeProvider projectId="cezar">
        <Probe />
      </ProjectScopeProvider>,
    )
    // The probe read apiPath/queryScope during ITS render — if the provider had waited
    // for an effect, the first paint would have fetched and cached under the wrong scope.
    expect(view.getByTestId('probe').textContent).toBe('cezar|/api/v1/p/cezar|cezar|/api/v1/p/cezar/runs')
    expect(getApiScope()).toBe('cezar')
  })

  it('follows a projectId change and resets to unscoped on unmount', () => {
    const view = render(
      <ProjectScopeProvider projectId="a">
        <Probe />
      </ProjectScopeProvider>,
    )
    expect(getApiScope()).toBe('a')

    view.rerender(
      <ProjectScopeProvider projectId="b">
        <Probe />
      </ProjectScopeProvider>,
    )
    expect(view.getByTestId('probe').textContent).toBe('b|/api/v1/p/b|b|/api/v1/p/b/runs')

    view.unmount()
    expect(getApiScope()).toBeNull()
  })

  // The composer's project pill (step 3.4) swaps scope by navigating, which remounts the
  // routed subtree under a provider whose projectId changed in the same commit. React runs
  // every destroy before any create, so a reset in the `[projectId]` effect's cleanup would
  // fire between the provider's render and the fresh children's mount effects — and their
  // first requests (the arriving project's skills, workflows, config) would go out unscoped.
  it('never dips back to unscoped while remounting children across a projectId change', () => {
    const seen: (string | null)[] = []
    /** Records the scope its mount effect sees — a child query's fetch timing, exactly. */
    function MountProbe() {
      useEffect(() => {
        seen.push(getApiScope())
      }, [])
      return null
    }

    const view = render(
      <ProjectScopeProvider projectId="a">
        <MountProbe key="a" />
      </ProjectScopeProvider>,
    )
    view.rerender(
      <ProjectScopeProvider projectId="b">
        <MountProbe key="b" />
      </ProjectScopeProvider>,
    )
    expect(seen).toEqual(['a', 'b'])
  })

  /**
   * The instance SWAP (`.ai/specs/2026-08-22-api-scope-ownership-token.md`) — the test above's
   * sibling, and the one the production failure needed.
   *
   * Keying the PROVIDER (not just the child) forces React to unmount one instance and mount a
   * different one in the same commit, which is exactly what navigating out of `/p/:projectId/*`
   * and back does: the global Tasks page, `/workspace/*`, `/settings`, the Back button. The
   * departing instance's unconditional `setApiScope(null)` used to land after the arriving one
   * had already claimed the slot, so every later request went out unscoped and reached the BOOT
   * project — `GET /api/v1/runs/<id>` for a task that lives in `cezar` — which 404s, and the
   * thread renders "Task not found" over a running task.
   *
   * Measured at BOTH points the production failure showed itself: a child's mount effect (a
   * query's first fetch) and a render after the commit (the re-keyed refetch that stuck).
   */
  it('never dips to unscoped when one provider instance replaces another', () => {
    const seen: (string | null)[] = []
    function MountProbe() {
      useEffect(() => {
        seen.push(getApiScope())
      }, [])
      return null
    }

    const tree = (instance: string) => (
      <ProjectScopeProvider key={instance} projectId="cezar">
        <MountProbe key={instance} />
        <Probe />
      </ProjectScopeProvider>
    )

    const view = render(tree('first'))
    expect(getApiScope()).toBe('cezar')

    view.rerender(tree('second'))

    // The arriving instance's children mounted scoped...
    expect(seen).toEqual(['cezar', 'cezar'])
    // ...and the slot is STILL scoped after the departing instance's cleanup ran, so the next
    // render keys and fetches under `cezar` rather than silently re-keying to `default`.
    expect(getApiScope()).toBe('cezar')
    expect(view.getByTestId('probe').textContent).toBe('cezar|/api/v1/p/cezar|cezar|/api/v1/p/cezar/runs')
  })

  it('still resets to unscoped when a provider leaves with no successor', () => {
    const view = render(
      <ProjectScopeProvider projectId="cezar">
        <Probe />
      </ProjectScopeProvider>,
    )
    expect(getApiScope()).toBe('cezar')
    view.unmount()
    expect(getApiScope()).toBeNull()
    expect(queryScope()).toBe('default')
  })

  it('passes null through as the unscoped boot project', () => {
    const view = render(
      <ProjectScopeProvider projectId={null}>
        <Probe />
      </ProjectScopeProvider>,
    )
    expect(view.getByTestId('probe').textContent).toBe('-|/api/v1|default|/api/v1/runs')
  })
})
