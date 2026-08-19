import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import {
  apiPath,
  type CreateNotificationTransportInput,
  type NotificationEventCatalogEntry,
  type NotificationQuietHours,
  type NotificationRateLimit,
  type NotificationsResponse,
  type NotificationTestResult,
  type NotificationTransportAuthInput,
  type NotificationTransportDeletedResponse,
  type NotificationTransportResponse,
  type TransportView,
  type UpdateNotificationTransportInput,
} from '@loki-labs/better-cezar-api-client'
import { ApiError, NO_REDIRECT, putWorkspaceUiState, throwIfIdentityGate } from '@/api/client'
import { useWorkspaceNotifications, useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { subscribeTopic } from '@/api/ws'
import { TransportHealth } from '@/components/transport-health'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import {
  normalizeNotifications,
  notificationSupport,
  type NotificationSupport,
} from '@/lib/notifications'

/**
 * Settings → Notifications (R6 Step 1.7, spec §"Cross-cutting").
 *
 * A GLOBAL section since the multi-project split (step 3.5): the browser doing the notifying
 * is one browser whichever project you are looking at, so the answer belongs to the user, not
 * to a repo. It persists in `~/.cezar/ui-state.json` via `PUT /api/workspace/ui-state`
 * (Migration 001 carried the pre-existing per-repo value up).
 *
 * One real knob: the browser-notification toggle, OFF by default. Two contracts it keeps:
 *
 *  - the preference persists via the same PUT-then-reconcile pattern as Appearance (1.3):
 *    flip locally for immediacy, PUT the full object, and on a failed write fall back to the
 *    server's truth rather than keep showing a choice the file never got. No localStorage
 *    mirror — nothing here affects first paint.
 *  - `Notification.requestPermission()` runs on ENABLE only, and only when the browser hasn't
 *    answered yet. A denial still persists the preference (it follows the user; permission is
 *    per-browser) — the section then says plainly that this browser is blocking delivery.
 *
 * **Extended for W4.9** (central-hub PLAN, F4 `CEZ_NOTIFY=1`): a second, independent pane below
 * the browser toggle — `ServerTransportsSection`, further down this file — for the machine-wide
 * outbound transport registry (`GET/PUT/POST/DELETE /api/v1/workspace/notifications*`). The two
 * panes answer different questions ("does THIS BROWSER TAB notify" vs "does the MACHINE notify
 * someone, browser or not") and share nothing: no key, no query, no mutation. See
 * `.ai/specs/2026-08-06-pluggable-notification-transports.md` "API Contracts" and the W4.9 row of
 * its Phases table for the cockpit's contract.
 */
export function NotificationsSection() {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()

  const [enabled, setEnabled] = React.useState(false)
  const [permission, setPermission] = React.useState<NotificationSupport>(notificationSupport)

  // The server's word wins — including "no notifications key" meaning the off default, so
  // wiping ui-state.json honestly resets every browser that visits.
  const serverState = uiState.data
  React.useEffect(() => {
    if (serverState === undefined) return
    setEnabled(normalizeNotifications(serverState.notifications).enabled)
  }, [serverState])

  const save = React.useCallback(
    (next: boolean) => {
      setEnabled(next)
      putWorkspaceUiState({ notifications: { enabled: next } })
        .then((merged) => queryClient.setQueryData(workspaceQueryKeys.uiState, merged))
        .catch((error: unknown) => {
          toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
          void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
        })
    },
    [queryClient],
  )

  const onToggle = React.useCallback(
    (next: boolean) => {
      if (!next) {
        save(false)
        return
      }
      // Permission is requested HERE and nowhere else (spec: "permission requested on enable
      // only") — and only when the browser has never been asked. `granted`/`denied` are final
      // answers Chrome would ignore a re-request for anyway.
      if (notificationSupport() !== 'default') {
        save(true)
        return
      }
      // Persist first, then ask: the preference is not conditional on the answer, and an
      // `await` before the write would let a closed permission prompt strand the toggle.
      save(true)
      Notification.requestPermission()
        .then((answer) => setPermission(answer))
        .catch(() => setPermission(notificationSupport()))
    },
    [save],
  )

  const unsupported = permission === 'unsupported'

  return (
    <div
      data-slot="notifications-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <section className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              <label htmlFor="notifications-enabled">Notify when an agent needs you</label>
            </h2>
            <p className="text-[13px] text-muted-foreground">
              A browser notification when a task starts waiting, asks for review, or fails —
              only while this tab is in the background. Off by default.
            </p>
          </div>
          <Switch
            id="notifications-enabled"
            data-slot="notifications-toggle"
            checked={enabled}
            disabled={unsupported}
            onCheckedChange={onToggle}
          />
        </div>

        {unsupported ? (
          <p data-slot="notifications-unsupported" className="text-[13px] text-muted-foreground">
            This browser does not support notifications, so the toggle is unavailable here.
          </p>
        ) : null}

        {!unsupported && enabled && permission === 'denied' ? (
          <p data-slot="notifications-denied" className="text-[13px] text-danger">
            This browser is blocking notifications for the cockpit. The preference is saved, but
            nothing will be delivered here until you allow notifications in the browser&apos;s
            site settings.
          </p>
        ) : null}
      </section>

      <ServerTransportsSection />
    </div>
  )
}

// =================================================================================================
// Server-side outbound transports (W4.9, F4 `CEZ_NOTIFY=1`) — everything below this line.
//
// **Local wire layer, deliberately not `@/api/client`.** `client.ts` (scaffold-owned, W1.1) has
// only the GET wrappers for this family today (`getWorkspaceNotifications`,
// `getWorkspaceNotificationsLog`) — its own comment says why: "Mutator wrappers are deliberately
// NOT added yet: every mutating route answers ONLY a 409 today (D19)... Each wave that gives its
// family a real success response (W4.1, W4.6, W4.7, P2.3, W4.10) adds the matching mutator
// function here." W4.7 (`notifications-routes.ts` + its client.ts wrappers) is a W4.9 dependency
// per the spec's Phases table, but per the dispatch contract this package touches ONLY the two
// files it owns — not `client.ts`, which is W4.7's to extend. So the four mutating calls below
// (`createTransport`/`updateTransport`/`deleteTransport`/`testTransport`) are hand-written here,
// mirroring the exact pattern `client.ts` itself already uses for the few routes `hc` cannot
// express (`registerProject`, `requestText`): `apiPath()` for the version+scope prefix (workspace
// routes are never project-scoped, so this resolves identically to the eventual `cez.api.v1.
// workspace.notifications...` calls), `credentials: 'include'` per the documented remote-cockpit
// policy, and the same `ApiError` contract every other call in this app ends in. Once W4.7 lands
// real wrappers in `client.ts`, this block becomes a thin wrapper of them — a rename, not a
// behavior change, because the wire shape is already the frozen contract
// (`packages/contract/src/notifications.ts`). Until then every mutating call below correctly
// surfaces the routes' current answer: a 409 `{error: "notifications are disabled — set
// CEZ_NOTIFY=1 to enable them"}`, because the family really is off/unbuilt right now.

async function requestNotificationsJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(apiPath(path), {
      ...init,
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
      ...NO_REDIRECT,
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, `cannot reach the cezar server (${path})`, { cause })
  }
  throwIfIdentityGate(res, path)
  const body = await res.text()
  let parsed: unknown
  try {
    parsed = body ? JSON.parse(body) : undefined
  } catch {
    parsed = undefined
  }
  if (!res.ok) {
    const json = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    const message =
      typeof json.error === 'string'
        ? json.error
        : `${res.status} ${res.statusText || 'request failed'}`.trim()
    throw new ApiError(res.status, message)
  }
  if (parsed === undefined) {
    throw new ApiError(res.status, `the cezar server answered ${path} with a non-JSON body`)
  }
  return parsed as T
}

const transportPath = (id: string, suffix = ''): string =>
  `/workspace/notifications/transports/${encodeURIComponent(id)}${suffix}`

function createTransport(input: CreateNotificationTransportInput): Promise<NotificationTransportResponse> {
  return requestNotificationsJson('/workspace/notifications/transports', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

function updateTransport(
  id: string,
  patch: UpdateNotificationTransportInput,
): Promise<NotificationTransportResponse> {
  return requestNotificationsJson(transportPath(id), { method: 'PUT', body: JSON.stringify(patch) })
}

function deleteTransport(id: string): Promise<NotificationTransportDeletedResponse> {
  return requestNotificationsJson(transportPath(id), { method: 'DELETE' })
}

function testTransport(id: string): Promise<NotificationTestResult> {
  return requestNotificationsJson(transportPath(id, '/test'), { method: 'POST' })
}

/** Fixed defaults for a transport created from this dialog (never exposed as fields here — the
 *  dialog's scope per the spec is "URL and auth env-var name"). `idempotencyKey` stays false
 *  because a GUI-created row is always `payload: 'envelope'`, which never renders
 *  `{{dedupeKey}}`; a template-driven row (the fan-out-ingress shape, where one endpoint relays to
 *  several channels server-side) is a CLI or JSON-file recipe, documented in the spec's
 *  "Configuration on a headless VPS", not a GUI path. */
const DEFAULT_TRANSPORT_CAPABILITIES: CreateNotificationTransportInput['capabilities'] = {
  maxTitleChars: 80,
  maxBodyChars: 1200,
  links: 'inline',
  markdown: false,
  batch: true,
  idempotencyKey: false,
}

/**
 * The machine-wide outbound transport registry: one row per instance, an add/edit dialog, and
 * per-row event matrix / quiet hours / rate limit. Reads `GET /workspace/notifications`, which
 * answers a schema-valid empty payload with `configured: false` whenever `CEZ_NOTIFY` is unset
 * (D19) — this pane renders that the same way it renders "on, zero rows configured yet": the one
 * empty state the spec names, plus a hint about the flag when it is the reason.
 */
function ServerTransportsSection() {
  const queryClient = useQueryClient()
  const query = useWorkspaceNotifications()

  // Demand-driven, same discipline as every other topic subscriber in this app
  // (`routes/knowledge/knowledge.tsx`'s `KnowledgeShell`) — held only while this pane is
  // mounted, no `refetchInterval`, no second socket.
  React.useEffect(() => {
    return subscribeTopic('notifications', () => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.notifications })
    })
  }, [queryClient])

  const [addOpen, setAddOpen] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)

  const data = query.data
  const transports = data?.transports ?? []
  const events = data?.events ?? []
  const editingTransport = editingId ? transports.find((t) => t.id === editingId) : undefined
  const dialogOpen = addOpen || editingTransport !== undefined

  const closeDialog = () => {
    setAddOpen(false)
    setEditingId(null)
  }

  return (
    <section
      data-slot="server-transports-section"
      className="flex flex-col gap-3 border-t border-border pt-7"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Outbound transports</h2>
          <p className="text-[13px] text-muted-foreground">
            Server-side delivery — a webhook, a chat relay, ntfy — that reaches you even when no
            browser tab is open.
            {data && !data.configured ? ' Set CEZ_NOTIFY=1 and restart cezar to turn it on.' : ''}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          Add transport
        </Button>
      </div>

      {data?.cockpitUrl.value ? (
        <p data-slot="notifications-cockpit-url" className="text-[12px] text-soft-foreground">
          Deep links point at <code>{data.cockpitUrl.value}</code> (
          {data.cockpitUrl.source === 'config'
            ? 'configured'
            : data.cockpitUrl.source === 'server-install'
              ? 'discovered'
              : 'loopback — probably unreachable from a phone'}
          )
        </p>
      ) : null}

      {query.isPending ? (
        <p className="text-[13px] text-soft-foreground">Loading transports…</p>
      ) : query.isError ? (
        <p className="text-[13px] text-danger">
          {query.error instanceof Error ? query.error.message : 'could not load transports'}
        </p>
      ) : transports.length === 0 ? (
        <p data-slot="notifications-transports-empty" className="text-[13px] text-soft-foreground">
          No transports configured. cezar sends nothing.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {transports.map((transport) => (
            <TransportRow
              key={transport.id}
              transport={transport}
              events={events}
              defaults={data?.defaults}
              onEdit={() => setEditingId(transport.id)}
            />
          ))}
        </div>
      )}

      <TransportDialog open={dialogOpen} transport={editingTransport} onOpenChange={(open) => {
        if (!open) closeDialog()
      }} />
    </section>
  )
}

function TransportRow({
  transport,
  events,
  defaults,
  onEdit,
}: {
  transport: TransportView
  events: NotificationEventCatalogEntry[]
  defaults: NotificationsResponse['defaults'] | undefined
  onEdit: () => void
}) {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = React.useState(false)
  const [testResult, setTestResult] = React.useState<NotificationTestResult | null>(null)

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.notifications })

  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) => updateTransport(transport.id, { enabled }),
    onSuccess: invalidate,
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const patch = useMutation({
    mutationFn: (body: UpdateNotificationTransportInput) => updateTransport(transport.id, body),
    onSuccess: invalidate,
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const remove = useMutation({
    mutationFn: () => deleteTransport(transport.id),
    onSuccess: () => {
      invalidate()
      toast(`${transport.label} removed`)
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const test = useMutation({
    mutationFn: () => testTransport(transport.id),
    onSuccess: (result) => {
      setTestResult(result)
      invalidate() // the send updates the row's stored health — refetch to see it
      toast(
        result.delivered
          ? `Test notification delivered to ${transport.label}`
          : (result.error ?? 'Delivery failed'),
        { tone: result.delivered ? 'default' : 'danger' },
      )
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  return (
    <div
      data-slot="transport-row"
      data-transport-id={transport.id}
      className="rounded-md border border-border bg-card px-3.5 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold text-foreground">{transport.label}</h3>
            <Badge variant="outline" className="uppercase">
              {transport.kind}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {transport.endpointHost || '—'}
          </p>
          <TransportHealth health={transport.health} className="mt-1.5" />
          {testResult ? (
            <p data-slot="transport-test-result" className="mt-1.5 text-[12px] text-muted-foreground">
              Test: {testResult.delivered ? 'delivered' : 'failed'}
              {testResult.httpStatus !== undefined ? ` (HTTP ${testResult.httpStatus})` : ''}
              {testResult.error ? ` — ${testResult.error}` : ''} in {testResult.durationMs}ms
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Switch
            checked={transport.enabled}
            aria-label={`Enable ${transport.label}`}
            disabled={toggleEnabled.isPending}
            onCheckedChange={(checked) => toggleEnabled.mutate(checked)}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? 'Sending…' : 'Send test'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button
            type="button"
            variant="danger-ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Remove
          </Button>
        </div>
      </div>

      <Collapsible open={expanded} onOpenChange={setExpanded} className="mt-2">
        <CollapsibleTrigger
          aria-label={`${expanded ? 'Hide' : 'Show'} ${transport.label} event settings`}
          className="text-[12px] font-medium text-muted-foreground hover:text-foreground"
        >
          {expanded ? 'Hide event settings' : 'Event settings, quiet hours & rate limit'}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 flex flex-col gap-3">
          <EventMatrix
            transport={transport}
            events={events}
            onChange={(nextEvents) => patch.mutate({ events: nextEvents })}
          />
          <QuietHoursEditor
            value={transport.quietHours}
            fallback={defaults?.quietHours ?? null}
            onChange={(next) => patch.mutate({ quietHours: next })}
          />
          <RateLimitEditor
            value={transport.rate}
            fallback={defaults?.rate}
            onChange={(next) => patch.mutate({ rate: next })}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

/** Driven entirely by the GET's `events[]` catalog — never a hardcoded client-side event list, so
 *  a new event id shows up here the moment the server starts naming it. `test` is excluded: it is
 *  never deduped, rate-limited or quiet-hours-suppressed (a human pressed a button), so it is not
 *  a configurable row. */
function EventMatrix({
  transport,
  events,
  onChange,
}: {
  transport: TransportView
  events: NotificationEventCatalogEntry[]
  onChange: (events: Record<string, boolean>) => void
}) {
  const configurable = events.filter((event) => event.id !== 'test')
  return (
    <fieldset data-slot="transport-event-matrix" className="flex flex-col gap-1.5">
      <legend className="text-[12px] font-medium text-muted-foreground">Events</legend>
      {configurable.map((event) => {
        const checked = transport.events[event.id] ?? event.defaultEnabled
        return (
          <label key={event.id} className="flex items-center justify-between gap-2 text-[12.5px]">
            <span className="flex items-center gap-2">
              {event.label}
              <Badge variant="outline" className="text-[10px] uppercase">
                {event.severity}
              </Badge>
            </span>
            <Switch
              size="sm"
              checked={checked}
              aria-label={`${event.label} notifications`}
              onCheckedChange={(next) => onChange({ ...transport.events, [event.id]: next })}
            />
          </label>
        )
      })}
    </fieldset>
  )
}

function QuietHoursEditor({
  value,
  fallback,
  onChange,
}: {
  value: NotificationQuietHours | null
  fallback: NotificationQuietHours | null
  onChange: (next: NotificationQuietHours | null) => void
}) {
  const override = value !== null
  const [draft, setDraft] = React.useState<NotificationQuietHours>(
    value ?? fallback ?? { start: '22:00', end: '07:00' },
  )

  React.useEffect(() => {
    if (value) setDraft(value)
  }, [value])

  return (
    <div data-slot="transport-quiet-hours" className="flex flex-col gap-1.5">
      <label className="flex items-center justify-between gap-2 text-[12.5px]">
        <span>Quiet hours override</span>
        <Switch
          size="sm"
          checked={override}
          aria-label="Override default quiet hours"
          onCheckedChange={(checked) => onChange(checked ? draft : null)}
        />
      </label>
      {override ? (
        <div className="flex flex-wrap items-center gap-2 pl-1">
          {/* Commits on blur, not per keystroke — a `time`/`number` input fires `onChange` on
           *  every digit, and a PUT per digit would spam the transport's own row while typing. */}
          <Input
            type="time"
            aria-label="Quiet hours start"
            value={draft.start}
            className="h-7 w-24 px-2 text-[12.5px]"
            onChange={(event) => setDraft({ ...draft, start: event.target.value })}
            onBlur={() => onChange(draft)}
          />
          <span className="text-soft-foreground">to</span>
          <Input
            type="time"
            aria-label="Quiet hours end"
            value={draft.end}
            className="h-7 w-24 px-2 text-[12.5px]"
            onChange={(event) => setDraft({ ...draft, end: event.target.value })}
            onBlur={() => onChange(draft)}
          />
        </div>
      ) : (
        <p className="pl-1 text-[11.5px] text-soft-foreground">
          {fallback
            ? `Uses the default window, ${fallback.start}–${fallback.end}.`
            : 'No quiet hours configured.'}
        </p>
      )}
    </div>
  )
}

function RateLimitEditor({
  value,
  fallback,
  onChange,
}: {
  value: NotificationRateLimit | null
  fallback: NotificationRateLimit | undefined
  onChange: (next: NotificationRateLimit | null) => void
}) {
  const override = value !== null
  const [draft, setDraft] = React.useState<NotificationRateLimit>(
    value ?? fallback ?? { perHour: 10, burst: 4, perMinute: 2 },
  )

  React.useEffect(() => {
    if (value) setDraft(value)
  }, [value])

  // Commits on blur, not per keystroke — see the identical note in `QuietHoursEditor`.
  const field = (key: keyof NotificationRateLimit, fieldLabel: string) => (
    <label key={key} className="flex items-center gap-1.5 text-[12px]">
      <span className="text-soft-foreground">{fieldLabel}</span>
      <Input
        type="number"
        min={0}
        aria-label={fieldLabel}
        value={draft[key]}
        className="h-7 w-16 px-2 text-[12.5px]"
        onChange={(event) => {
          const parsed = Number(event.target.value)
          setDraft({ ...draft, [key]: Number.isFinite(parsed) ? parsed : 0 })
        }}
        onBlur={() => onChange(draft)}
      />
    </label>
  )

  return (
    <div data-slot="transport-rate-limit" className="flex flex-col gap-1.5">
      <label className="flex items-center justify-between gap-2 text-[12.5px]">
        <span>Rate limit override</span>
        <Switch
          size="sm"
          checked={override}
          aria-label="Override default rate limit"
          onCheckedChange={(checked) => onChange(checked ? draft : null)}
        />
      </label>
      {override ? (
        <div className="flex flex-wrap items-center gap-3 pl-1">
          {field('perHour', 'per hour')}
          {field('burst', 'burst')}
          {field('perMinute', 'per minute')}
        </div>
      ) : (
        <p className="pl-1 text-[11.5px] text-soft-foreground">
          {fallback
            ? `Uses the default limit: ${fallback.perHour}/hour, burst ${fallback.burst}, ${fallback.perMinute}/minute.`
            : 'No rate limit configured.'}
        </p>
      )}
    </div>
  )
}

type TransportAuthMode = 'unset' | 'env' | 'inline'

/**
 * Add/edit dialog. Scope per the spec's W4.9 acceptance: "takes URL and auth env-var name" — id
 * and label are the minimum this schema needs to create a row at all, and an inline-secret option
 * rides along the same field because the contract's write-only auth union offers it for free. No
 * capability, quiet-hours, payload-template or project-filter field lives here; those are the
 * per-row expander's job (`TransportRow`) or the CLI/JSON-file path the spec documents for the
 * template-driven (fan-out-ingress) case.
 *
 * **Never renders a stored secret.** The inline field always starts empty; on edit, leaving auth
 * untouched (`authMode === 'unset'`) submits the documented `auth.inline === "__unchanged__"`
 * sentinel rather than omitting the key, so this is directly testable rather than inferred from
 * absence.
 */
function TransportDialog({
  open,
  transport,
  onOpenChange,
}: {
  open: boolean
  transport?: TransportView
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const isEdit = transport !== undefined

  const [id, setId] = React.useState('')
  const [label, setLabel] = React.useState('')
  const [url, setUrl] = React.useState('')
  const [authMode, setAuthMode] = React.useState<TransportAuthMode>('unset')
  const [envVar, setEnvVar] = React.useState('')
  const [inlineValue, setInlineValue] = React.useState('')

  // Re-seed from the row being opened, and ONLY then — never mid-edit, matching
  // `routes/knowledge/editor.tsx`'s "reset only when a different document loads" discipline.
  const transportId = transport?.id
  React.useEffect(() => {
    if (!open) return
    setId(transportId ?? '')
    setLabel(transport?.label ?? '')
    setUrl('')
    setAuthMode('unset')
    setEnvVar(transport?.auth.source === 'env' ? transport.auth.envVar : '')
    setInlineValue('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, transportId])

  const create = useMutation({
    mutationFn: (input: CreateNotificationTransportInput) => createTransport(input),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.notifications })
      toast(`${result.transport.label} added`)
      onOpenChange(false)
    },
  })

  const update = useMutation({
    mutationFn: (input: UpdateNotificationTransportInput) => updateTransport(transportId ?? '', input),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.notifications })
      toast(`${result.transport.label} updated`)
      onOpenChange(false)
    },
  })

  const pending = create.isPending || update.isPending
  const submitError = create.error ?? update.error

  /** `undefined` on create means "no auth configured" (the key is omitted from the POST body).
   *  On edit it means "leave auth unchanged", spelled as the documented sentinel rather than
   *  omission — see the docblock above. */
  const authPatch = (): NotificationTransportAuthInput | undefined => {
    if (authMode === 'env') return { scheme: 'bearer', envVar: envVar.trim() }
    if (authMode === 'inline') return { scheme: 'bearer', inline: inlineValue }
    if (isEdit) return { scheme: 'bearer', inline: '__unchanged__' }
    return undefined
  }

  const submit = () => {
    const trimmedId = id.trim()
    const trimmedLabel = label.trim()
    const trimmedUrl = url.trim()
    const auth = authPatch()

    if (isEdit && transportId) {
      const webhook: NonNullable<UpdateNotificationTransportInput['webhook']> = {
        ...(trimmedUrl ? { url: trimmedUrl } : {}),
        ...(auth ? { auth } : {}),
      }
      update.mutate({
        ...(trimmedLabel && trimmedLabel !== transport?.label ? { label: trimmedLabel } : {}),
        ...(Object.keys(webhook).length > 0 ? { webhook } : {}),
      })
      return
    }

    if (!trimmedId || !trimmedUrl) return
    create.mutate({
      id: trimmedId,
      label: trimmedLabel || trimmedId,
      capabilities: DEFAULT_TRANSPORT_CAPABILITIES,
      webhook: {
        url: trimmedUrl,
        payload: 'envelope',
        ...(auth ? { auth } : {}),
      },
    })
  }

  const authView = isEdit ? transport?.auth : undefined
  const canSubmit = isEdit ? true : id.trim() !== '' && url.trim() !== ''

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent data-slot="transport-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${transport?.label}` : 'Add transport'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'The endpoint URL and auth are write-only — leave them blank to keep what is already configured.'
              : 'A webhook transport: cezar POSTs a JSON body to this URL on every notify-worthy event.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {!isEdit ? (
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted-foreground">Id</span>
              <Input
                aria-label="Transport id"
                data-slot="transport-dialog-id"
                value={id}
                placeholder="ntfy"
                onChange={(event) => setId(event.target.value)}
              />
            </label>
          ) : (
            <p className="text-[12px] text-soft-foreground">
              Id <code>{transportId}</code> (fixed)
            </p>
          )}

          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-muted-foreground">Label</span>
            <Input
              aria-label="Transport label"
              data-slot="transport-dialog-label"
              value={label}
              placeholder="Ntfy Push"
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-muted-foreground">Webhook URL</span>
            <Input
              aria-label="Webhook URL"
              data-slot="transport-dialog-url"
              value={url}
              placeholder={
                isEdit ? `Leave blank to keep ${transport?.endpointHost}${transport?.endpointPath}` : 'https://…'
              }
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[13px]">
              <span className="shrink-0 text-muted-foreground">Auth</span>
              <select
                aria-label="Auth mode"
                data-slot="transport-dialog-auth-mode"
                value={authMode}
                onChange={(event) => setAuthMode(event.target.value as TransportAuthMode)}
                className="rounded-md border border-input bg-card px-2 py-1 text-[13px] outline-none focus-visible:border-ring"
              >
                <option value="unset">{isEdit ? 'Leave unchanged' : 'No auth'}</option>
                <option value="env">Environment variable</option>
                <option value="inline">Inline value</option>
              </select>
            </label>

            {authMode === 'env' ? (
              <Input
                aria-label="Environment variable name"
                data-slot="transport-dialog-auth-envvar"
                value={envVar}
                placeholder="CEZ_NOTIFY_TOKEN"
                onChange={(event) => setEnvVar(event.target.value)}
              />
            ) : null}
            {authMode === 'inline' ? (
              <Input
                type="password"
                aria-label="Inline auth value"
                data-slot="transport-dialog-auth-inline"
                value={inlineValue}
                placeholder="never displayed once saved"
                onChange={(event) => setInlineValue(event.target.value)}
              />
            ) : null}

            {authView ? (
              <p data-slot="transport-dialog-auth-current" className="text-[11.5px] text-soft-foreground">
                {authView.source === 'env'
                  ? `Currently reads $${authView.envVar} — ${authView.present ? 'present' : 'not found'} in the environment.`
                  : authView.source === 'inline'
                    ? `Currently an inline value${authView.present ? (authView.hint ? ` ending in ${authView.hint}` : '') : ' (not set)'}.`
                    : 'No auth currently configured.'}
              </p>
            ) : null}
          </div>
        </div>

        {submitError ? (
          <p data-slot="transport-dialog-error" className="min-w-0 break-words text-[13px] text-danger">
            {submitError instanceof Error ? submitError.message : 'could not save that transport'}
          </p>
        ) : null}

        <DialogFooter className="min-w-0 sm:items-center sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-slot="transport-dialog-confirm"
            disabled={!canSubmit || pending}
            onClick={submit}
          >
            {pending ? 'Saving…' : isEdit ? 'Save' : 'Add transport'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
