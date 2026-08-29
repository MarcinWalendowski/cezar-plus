import type { ProviderStatus, ProviderStatusResponse, Runner } from '@loki-labs/better-cezar-api-client'

const RUNNER_ORDER: readonly Runner[] = ['claude', 'codex', 'opencode', 'pi']
const PROVIDER_STATES = new Set(['connected', 'disconnected', 'not-installed', 'unknown'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export type ProviderStatusEventRow = Omit<ProviderStatus, 'enabled'> & { enabled?: boolean }

function parseProviderStatusRow(
  value: unknown,
  requireEnabled: boolean,
): ProviderStatusEventRow | null {
  if (!isRecord(value)) return null
  const { provider, status, enabled, hint, authFailureId, poolConnected } = value
  if (
    typeof provider !== 'string'
    || !RUNNER_ORDER.includes(provider as Runner)
    || typeof status !== 'string'
    || !PROVIDER_STATES.has(status)
    || (requireEnabled && typeof enabled !== 'boolean')
    || (!requireEnabled && enabled !== undefined && typeof enabled !== 'boolean')
    || (hint !== undefined && typeof hint !== 'string')
    || (
      authFailureId !== undefined
      && (
        typeof authFailureId !== 'string'
        || authFailureId.length < 1
        || authFailureId.length > 128
        || status !== 'disconnected'
      )
    )
    || (poolConnected !== undefined && typeof poolConnected !== 'boolean')
  ) return null
  return {
    provider: provider as Runner,
    status: status as ProviderStatus['status'],
    ...(typeof enabled === 'boolean' ? { enabled } : {}),
    ...(hint === undefined ? {} : { hint }),
    ...(authFailureId === undefined ? {} : { authFailureId }),
    ...(poolConnected === undefined ? {} : { poolConnected: poolConnected as boolean }),
  }
}

export function parseProviderStatusEventRow(value: unknown): ProviderStatusEventRow | null {
  return parseProviderStatusRow(value, false)
}

function safeProviderRows(value: unknown, requireEnabled: boolean): ProviderStatusEventRow[] | null {
  if (!isRecord(value) || !Array.isArray(value.providers)) return null
  const rows: ProviderStatusEventRow[] = []
  const seen = new Set<string>()
  for (const valueRow of value.providers) {
    const row = parseProviderStatusRow(valueRow, requireEnabled)
    if (row === null || seen.has(row.provider)) return null
    seen.add(row.provider)
    rows.push(row)
  }
  return rows
}

function completeProviderRows(value: unknown): ProviderStatus[] | null {
  const rows = safeProviderRows(value, true)
  if (rows === null || rows.length === 0) return null
  const byProvider = new Map(rows.map((row) => [row.provider, row]))
  return RUNNER_ORDER.flatMap((provider) => {
    const row = byProvider.get(provider)
    return row ? [row as ProviderStatus] : []
  })
}

export function parseProviderStatusResponse(value: unknown): ProviderStatusResponse {
  const rows = completeProviderRows(value)
  if (rows === null) {
    throw new Error('Invalid provider status response')
  }
  return { providers: rows }
}

export function applyProviderStatusRow(
  response: ProviderStatusResponse | undefined,
  row: ProviderStatusEventRow,
): ProviderStatusResponse | undefined {
  const providers = completeProviderRows(response)
  if (providers === null) return undefined
  return {
    providers: providers.map((candidate) => {
      if (candidate.provider !== row.provider) return candidate
      // An event row owns discovery/runtime status. Only enablement is additive because runtime
      // rows intentionally omit the workspace preference; carrying old hints or incident ids
      // through a connected recovery would otherwise leave another tab falsely red.
      return {
        provider: row.provider,
        status: row.status,
        enabled: row.enabled ?? candidate.enabled,
        ...(row.hint === undefined ? {} : { hint: row.hint }),
        ...(row.authFailureId === undefined ? {} : { authFailureId: row.authFailureId }),
        // `poolConnected` is ADDITIVE, not replaced: the routes that emit this topic (enable
        // toggle, connect/repoint handlers) only know about the default row and never carry a
        // pool aggregate at all, so an absent field here means "this event says nothing about
        // the pool", not "the pool is empty" — an unrelated enable/disable click must not flicker
        // a healthy pool's dot off (`.ai/specs/2026-08-25-logged-out-account-fallback.md`).
        ...(row.poolConnected !== undefined
          ? { poolConnected: row.poolConnected }
          : candidate.poolConnected !== undefined
            ? { poolConnected: candidate.poolConnected }
            : {}),
      }
    }),
  }
}

/**
 * Fold a complete HTTP answer into the workspace cache. A row is authoritative only when its
 * cached value still matches the snapshot captured at request start; an SSE update in between
 * wins. Retry is the sole clearing exception, and it may clear only the id it submitted.
 */
export function mergeProviderStatusResponse(
  requestStart: ProviderStatusResponse | undefined,
  cached: ProviderStatusResponse | undefined,
  response: ProviderStatusResponse,
  retryIncidentId?: string,
): ProviderStatusResponse {
  const requestStartRows = completeProviderRows(requestStart)
  const cachedRows = completeProviderRows(cached)
  const responseRows = completeProviderRows(response)
  if (responseRows === null || cachedRows === null) return response
  if (requestStartRows === null) return { providers: cachedRows }
  const requestStartByProvider = new Map(requestStartRows.map((row) => [row.provider, row]))
  const cachedByProvider = new Map(cachedRows.map((row) => [row.provider, row]))

  return {
    providers: responseRows.map((incoming) => {
      const before = requestStartByProvider.get(incoming.provider)
      const current = cachedByProvider.get(incoming.provider)
      if (before === undefined || current === undefined) return current ?? incoming
      const retryClearsCurrent = retryIncidentId !== undefined
        && current.authFailureId === retryIncidentId
        && incoming.authFailureId === undefined
      const clearsDifferentIncident = retryIncidentId !== undefined
        && current.authFailureId !== undefined
        && current.authFailureId !== retryIncidentId
        && incoming.authFailureId === undefined
      if (clearsDifferentIncident) return current
      if (sameProviderStatusRow(before, current)) return incoming
      if (retryClearsCurrent) {
        return { ...incoming, enabled: current.enabled }
      }
      // poolConnected is advisory-only (see the docblock below): a cache that diverged from the
      // request-start snapshot ONLY on that field is not the "an SSE update raced in mid-request"
      // case the fallback below exists for — it must not make the code distrust an otherwise
      // unchanged response.
      if (sameProviderStatusRowIgnoringPool(before, current)) return incoming
      return current
    }),
  }
}

function sameProviderStatusRow(left: ProviderStatus, right: ProviderStatus): boolean {
  return left.provider === right.provider
    && left.status === right.status
    && left.enabled === right.enabled
    && left.hint === right.hint
    && left.authFailureId === right.authFailureId
    && left.poolConnected === right.poolConnected
}

function sameProviderStatusRowIgnoringPool(left: ProviderStatus, right: ProviderStatus): boolean {
  return left.provider === right.provider
    && left.status === right.status
    && left.enabled === right.enabled
    && left.hint === right.hint
    && left.authFailureId === right.authFailureId
}

/**
 * ADVISORY only (spec `2026-08-25-logged-out-account-fallback.md`, Solution 6): `poolConnected`
 * widens a provider whose discovered default is dead but whose pool has a healthy non-default
 * login, so the picker and the provider dots stop lying about it. Nothing downstream may treat
 * this list as a guarantee — a reroutable submission is what the server actually decides, and a
 * pinned handoff (Terminal / Open-in-CLI) is refused server-side rather than hidden here.
 */
export function usableRunners(status: ProviderStatusResponse | undefined): Runner[] {
  const rows = completeProviderRows(status)
  if (rows === null) return []
  const usable = new Set(
    rows
      .filter((row) => row.enabled && (row.status === 'connected' || row.poolConnected === true))
      .map((row) => row.provider),
  )
  return RUNNER_ORDER.filter((runner) => usable.has(runner))
}

export function providerStatusFor(
  status: ProviderStatusResponse | undefined,
  provider: Runner,
): ProviderStatus | undefined {
  return completeProviderRows(status)?.find((row) => row.provider === provider)
}
