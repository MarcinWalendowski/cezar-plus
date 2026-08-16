import { useMutation } from '@tanstack/react-query'
import { PlugZapIcon, RefreshCwIcon } from 'lucide-react'
import { useState } from 'react'

import { useHealth, useSourceProviders, useSources } from '@/api/queries'
import type {
  CreateSourceConnectionInput,
  SourceConnectionWire,
  SourceProviderInfo,
} from '@loki-labs/better-cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { SourceStatusBadge } from '@/components/source-status-badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

/**
 * Settings → Sources (F2, central-hub scaffold, `CEZ_SOURCES=1`). Project scope.
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` "UI/UX", narrowed to this
 * package's own brief: configure a connection, list connections, refresh one on demand, and
 * show a connection as stale or erroring. The document browser, the comment stream and the
 * conflict resolver are a later pass (see this file's own "not built here" note below).
 *
 * `visibleSettingsSections` keeps this entry out of the nav and unrouted while
 * `capabilities.sources` is false, so the "off" branch below is reachable only through a stale
 * bookmark or a direct visit while the flag is unset — never a plain 404 (D19's shape applies to
 * the cockpit surface too, not only the HTTP routes).
 *
 * ## The mutation gap this package inherited
 *
 * `packages/web/src/api/client.ts` and `queries.ts` are the central-hub scaffold's exclusive
 * files (PLAN.md D6, dispatch clause 5) and, as landed, only carry the sources family's READS
 * (`useSources`, `useSourceProviders`, …) — there is no `createSourceConnection`,
 * `updateSourceConnection`, or `syncSourceConnection` wrapper for this package to call, and this
 * package may not add one without touching a file it does not own. Rather than a button that
 * silently does nothing (indistinguishable from a broken app) or one permanently greyed out with
 * no way to know why, "Add source" and "Sync now" below are wired to a real `useMutation` that
 * fails LOUDLY through the same toast path a genuine `ApiError` would take, naming exactly what
 * is missing. Swap `unwiredSourceMutation` for the real client function once one exists — the
 * `useMutation({ mutationFn })` call shape does not change.
 */
export function SourcesSection() {
  const health = useHealth()

  // Health undecided yet: render neither branch. `SourcesPane` fires real queries
  // (`useSources`, `useSourceProviders`) the instant it mounts, and D4/D19's "off means no
  // fetch" only holds if that mount waits for a confirmed "on" rather than racing ahead during
  // the loading window on the assumption the flag will turn out to be set.
  if (health.data === undefined) {
    return (
      <div data-route="settings-sources" className="flex flex-col gap-4">
        <p data-slot="sources-health-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
          Loading…
        </p>
      </div>
    )
  }

  const sourcesAvailable = health.data.capabilities?.sources === true

  return (
    <div data-route="settings-sources" className="flex flex-col gap-4">
      {sourcesAvailable ? (
        <SourcesPane />
      ) : (
        <CenteredState
          icon={<PlugZapIcon />}
          tone="neutral"
          title="External sources are off"
          subtitle="Set CEZ_SOURCES=1 and restart cezar to turn them on."
          heading="h2"
        />
      )}
    </div>
  )
}

/** A mutation this package cannot wire yet (see the module docblock) — fails with a message
 *  naming exactly what is missing, through the same `onError` → toast path a real `ApiError`
 *  would take, so a click never reads as the button simply doing nothing. */
async function unwiredSourceMutation(action: string): Promise<never> {
  throw new Error(
    `${action} needs a mutation wrapper in packages/web/src/api/client.ts — not wired up yet.`,
  )
}

function SourcesPane() {
  const connections = useSources()
  const providers = useSourceProviders()
  const [addOpen, setAddOpen] = useState(false)

  const syncConnection = useMutation({
    mutationFn: (_connectionId: string) => unwiredSourceMutation('Refreshing this source'),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (connections.isPending) {
    return (
      <p data-slot="sources-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading sources…
      </p>
    )
  }
  if (connections.isError) {
    return (
      <CenteredState
        icon={<PlugZapIcon />}
        tone="danger"
        heading="h2"
        title="Sources did not load"
        subtitle={connections.error.message}
      />
    )
  }

  const rows = connections.data.connections

  return (
    <div
      data-slot="sources-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Sources</h2>
          <p className="text-[13px] text-muted-foreground">
            Mirror an external workspace — Notion first — into the knowledge base. Read only:
            nothing is ever written or deleted on the remote.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-action="sources-add"
          onClick={() => setAddOpen(true)}
        >
          Add source
        </Button>
      </div>

      {rows.length === 0 ? (
        <CenteredState
          icon={<PlugZapIcon />}
          tone="neutral"
          heading="h2"
          title="No sources yet"
          subtitle="Add a source to start mirroring an external workspace here."
          actions={
            <Button type="button" size="sm" data-action="sources-add-empty" onClick={() => setAddOpen(true)}>
              Add source
            </Button>
          }
        />
      ) : (
        <ul data-slot="sources-list" className="divide-y divide-border/60 rounded-md border border-border bg-card">
          {rows.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              onSync={() => syncConnection.mutate(connection.id)}
              syncing={syncConnection.isPending}
            />
          ))}
        </ul>
      )}

      {addOpen ? (
        <AddSourceDialog
          providers={providers.data?.providers ?? []}
          providersLoading={providers.isPending}
          onOpenChange={setAddOpen}
        />
      ) : null}
    </div>
  )
}

/** The stored reason a row's badge shows, in the provider's or the sweep's own words — never
 *  invented here (spec, "Edge Cases": "the reason shown verbatim"). */
function reasonFor(connection: SourceConnectionWire): string | undefined {
  if (connection.syncState === 'unavailable') return connection.availability.reason
  if (connection.syncState === 'error') return connection.lastErrorMessage
  return undefined
}

function ConnectionRow({
  connection,
  onSync,
  syncing,
}: {
  connection: SourceConnectionWire
  onSync: () => void
  syncing: boolean
}) {
  return (
    <li data-slot="source-row" data-connection-id={connection.id} className="flex flex-col gap-2 px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-foreground">{connection.name}</span>
            <span className="text-[11px] text-soft-foreground">{connection.kind}</span>
          </div>
          <div className="mt-1">
            <SourceStatusBadge syncState={connection.syncState} reason={reasonFor(connection)} />
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          data-action="source-sync"
          disabled={syncing || connection.mode === 'archived'}
          onClick={onSync}
        >
          <RefreshCwIcon aria-hidden="true" />
          Sync now
        </Button>
      </div>

      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-soft-foreground">
        <div className="flex items-center gap-1">
          <dt>Documents</dt>
          <dd data-slot="source-document-count" className="font-medium text-foreground">
            {connection.documentCount}
          </dd>
        </div>
        {connection.conflictCount > 0 ? (
          <div className="flex items-center gap-1">
            <dt>Conflicts</dt>
            <dd data-slot="source-conflict-count" className="font-medium text-danger">
              {connection.conflictCount}
            </dd>
          </div>
        ) : null}
        {connection.nextDueAt ? (
          <div className="flex items-center gap-1">
            <dt>Next sync</dt>
            <dd>
              <time dateTime={connection.nextDueAt} data-slot="source-next-due">
                {connection.nextDueAt}
              </time>
            </dd>
          </div>
        ) : null}
      </dl>
    </li>
  )
}

function AddSourceDialog({
  providers,
  providersLoading,
  onOpenChange,
}: {
  providers: readonly SourceProviderInfo[]
  providersLoading: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [selectedKind, setSelectedKind] = useState<string | null>(null)
  const [name, setName] = useState('')

  const createConnection = useMutation({
    mutationFn: (_input: CreateSourceConnectionInput) => unwiredSourceMutation('Adding a source'),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const selected = providers.find((provider) => provider.kind === selectedKind) ?? null
  const canSubmit = selected !== null && selected.availability.available && name.trim() !== ''

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-slot="source-add-dialog">
        <DialogHeader>
          <DialogTitle>Add a source</DialogTitle>
          <DialogDescription>
            Pick a provider, then name the connection. Nothing here ever asks for a credential —
            it is read from the machine&apos;s own environment.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">Provider</span>
          {providersLoading ? (
            <p className="text-[13px] text-soft-foreground">Loading providers…</p>
          ) : providers.length === 0 ? (
            <p data-slot="source-providers-empty" className="text-[13px] text-soft-foreground">
              No providers are registered in this build.
            </p>
          ) : (
            <ul data-slot="source-provider-list" className="flex flex-col gap-1.5">
              {providers.map((provider) => (
                <ProviderOption
                  key={provider.kind}
                  provider={provider}
                  selected={provider.kind === selectedKind}
                  onSelect={() => setSelectedKind(provider.kind)}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="source-name">Connection name</Label>
          <Input
            id="source-name"
            data-slot="source-name-input"
            placeholder="e.g. Team knowledge"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={selected === null}
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-action="source-create"
            disabled={!canSubmit || createConnection.isPending}
            onClick={() =>
              selected &&
              createConnection.mutate({ kind: selected.kind, name: name.trim() })
            }
          >
            Create connection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One provider in the picker. An unavailable provider is rendered GREYED, never hidden, with its
 * exact reason string present in the DOM — hiding it answers "why can't I add Notion?" with
 * nothing (spec, "UI/UX"). The credential hint is the only credential-shaped thing on this page:
 * a copyable environment-variable name, never an input.
 */
function ProviderOption({
  provider,
  selected,
  onSelect,
}: {
  provider: SourceProviderInfo
  selected: boolean
  onSelect: () => void
}) {
  const available = provider.availability.available

  const copyHint = async () => {
    if (!provider.credentialHint) return
    try {
      await navigator.clipboard.writeText(provider.credentialHint)
      toast('Copied.')
    } catch {
      toast('Copy failed.', { tone: 'danger' })
    }
  }

  return (
    <li
      data-slot="source-provider-option"
      data-kind={provider.kind}
      data-available={available}
      className={cn(
        'flex flex-col gap-1.5 rounded-md border px-3 py-2.5 text-left',
        available
          ? cn('cursor-pointer border-border bg-card hover:bg-muted', selected && 'border-primary bg-primary/5')
          : 'cursor-not-allowed border-border/60 bg-muted/40 opacity-60',
      )}
    >
      <button
        type="button"
        disabled={!available}
        aria-pressed={selected}
        onClick={onSelect}
        className="flex w-full items-center justify-between gap-3 text-left disabled:cursor-not-allowed"
      >
        <span className="text-[13px] font-medium text-foreground">{provider.label}</span>
        <span className="text-[11px] text-soft-foreground">
          {provider.capabilities.push ? 'read/write' : 'read only'}
        </span>
      </button>

      {!available && provider.availability.reason ? (
        <p data-slot="source-provider-unavailable-reason" className="text-[12px] text-soft-foreground">
          {provider.availability.reason}
        </p>
      ) : null}

      {provider.credentialHint ? (
        <button
          type="button"
          data-slot="source-credential-hint"
          onClick={() => void copyHint()}
          title="Copy"
          className="w-fit rounded-sm bg-muted px-1.5 py-0.5 text-left font-mono text-[11px] text-muted-foreground hover:bg-muted/70"
        >
          {provider.credentialHint}
        </button>
      ) : null}
    </li>
  )
}
