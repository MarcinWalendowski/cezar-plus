import { PlugZapIcon, RefreshCwIcon } from 'lucide-react'
import { useState } from 'react'

import {
  useAdoptSourceDocument,
  useCreateSourceConnection,
  useDeleteSourceConnection,
  useHealth,
  useResolveSourceConflict,
  useSourceComments,
  useSourceDocument,
  useSourceDocuments,
  useSourceProviders,
  useSources,
  useSyncSourceConnection,
  useUpdateSourceConnection,
} from '@/api/queries'
import type {
  CreateSourceConnectionInput,
  SourceConnectionWire,
  SourceProviderInfo,
  SourceDocumentListItem,
} from '@loki-labs/better-cezar-api-client'
import { queryScope } from '@loki-labs/better-cezar-api-client'
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
import { track } from '@/lib/analytics'
import { cn } from '@/lib/utils'

/**
 * Settings → Sources (F2, `CEZ_SOURCES=1`). Project scope.
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` "UI/UX", narrowed to this
 * package's brief: configure connections, browse mirrored documents and comments, refresh on
 * demand, and resolve local/remote conflicts without writing to the remote provider.
 *
 * `visibleSettingsSections` keeps this entry out of the nav and unrouted while
 * `capabilities.sources` is false, so the "off" branch below is reachable only through a stale
 * bookmark or a direct visit while the flag is unset — never a plain 404 (D19's shape applies to
 * the cockpit surface too, not only the HTTP routes).
 *
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

function SourcesPane() {
  const connections = useSources()
  const providers = useSourceProviders()
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<SourceConnectionWire | null>(null)
  const [deleting, setDeleting] = useState<SourceConnectionWire | null>(null)
  const [browsing, setBrowsing] = useState<SourceConnectionWire | null>(null)
  const syncConnection = useSyncSourceConnection()
  const deleteConnection = useDeleteSourceConnection()

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
              onSync={() => syncConnection.mutate(connection.id, {
                onSuccess: () => trackSourceEvent('source.sync_requested', connection),
                onError: (error) => toast(error.message, { tone: 'danger' }),
              })}
              onEdit={() => setEditing(connection)}
              onDelete={() => setDeleting(connection)}
              onBrowse={() => setBrowsing(connection)}
              syncing={syncConnection.isPending && syncConnection.variables === connection.id}
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
      {editing ? (
        <AddSourceDialog
          providers={providers.data?.providers ?? []}
          providersLoading={providers.isPending}
          initial={editing}
          onOpenChange={(open) => !open && setEditing(null)}
        />
      ) : null}
      {deleting ? (
        <Dialog open onOpenChange={(open) => !open && setDeleting(null)}>
          <DialogContent data-slot="source-delete-dialog">
            <DialogHeader>
              <DialogTitle>Delete {deleting.name}?</DialogTitle>
              <DialogDescription>
                This removes the connection definition. Mirrored files remain on disk until you remove them separately.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
              <Button
                type="button"
                variant="danger-ghost"
                data-action="source-delete-confirm"
                disabled={deleteConnection.isPending}
                onClick={() => deleteConnection.mutate(deleting.id, {
                  onSuccess: () => setDeleting(null),
                  onError: (error) => toast(error.message, { tone: 'danger' }),
                })}
              >
                Delete connection
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {browsing ? <SourceBrowser connection={browsing} onClose={() => setBrowsing(null)} /> : null}
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

function trackSourceEvent(
  name: string,
  connection: Pick<SourceConnectionWire, 'id' | 'kind'>,
  extra: Record<string, string | number | boolean> = {},
): void {
  track(name, {
    project: queryScope(),
    providerKind: connection.kind,
    connectionId: connection.id,
    ...extra,
  })
}

function ConnectionRow({
  connection,
  onSync,
  onEdit,
  onDelete,
  onBrowse,
  syncing,
}: {
  connection: SourceConnectionWire
  onSync: () => void
  onEdit: () => void
  onDelete: () => void
  onBrowse: () => void
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

        <div className="flex flex-wrap gap-1.5">
          <Button type="button" variant="ghost" size="sm" data-action="source-browse" onClick={onBrowse}>
            Browse
          </Button>
          <Button type="button" variant="ghost" size="sm" data-action="source-edit" onClick={onEdit}>
            Edit
          </Button>
          <Button type="button" variant="ghost" size="sm" data-action="source-delete" onClick={onDelete}>
            Delete
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="source-sync"
            disabled={syncing || !connection.enabled || connection.mode === 'archived' || !connection.availability.available}
            onClick={onSync}
          >
            <RefreshCwIcon aria-hidden="true" />
            Sync now
          </Button>
        </div>
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
      {connection.collections.length > 0 ? (
        <div data-slot="source-configured-collections" className="text-[11.5px] text-soft-foreground">
          <span className="font-medium text-foreground">Configured collections:</span>{' '}
          {connection.collections.map((collection) => `${collection.label ?? collection.externalId} (${collection.collectionKind})`).join(', ')}
        </div>
      ) : null}
    </li>
  )
}

function AddSourceDialog({
  providers,
  providersLoading,
  initial,
  onOpenChange,
}: {
  providers: readonly SourceProviderInfo[]
  providersLoading: boolean
  initial?: SourceConnectionWire
  onOpenChange: (open: boolean) => void
}) {
  const [selectedKind, setSelectedKind] = useState<string | null>(initial?.kind ?? null)
  const [name, setName] = useState(initial?.name ?? '')
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [mode, setMode] = useState<'mirror' | 'archived'>(initial?.mode ?? 'mirror')
  const [intervalSeconds, setIntervalSeconds] = useState(initial?.intervalSeconds ?? 900)
  const [watchComments, setWatchComments] = useState(initial?.watchComments ?? false)
  const [collectionId, setCollectionId] = useState(initial?.collections[0]?.externalId ?? '')
  const [collectionKind, setCollectionKind] = useState<'database' | 'page-tree'>(initial?.collections[0]?.collectionKind ?? 'page-tree')
  const createConnection = useCreateSourceConnection()
  const updateConnection = useUpdateSourceConnection()

  const selected = providers.find((provider) => provider.kind === selectedKind) ?? null
  const minimumInterval = selectedKind === 'cezar-hub' ? 60 : 300
  const canSubmit = selected !== null && (initial || selected.availability.available) && name.trim() !== '' && collectionId.trim() !== '' && intervalSeconds >= minimumInterval
  const mutationPending = createConnection.isPending || updateConnection.isPending
  const input: CreateSourceConnectionInput = {
    kind: selectedKind ?? '',
    name: name.trim(),
    enabled,
    mode,
    intervalSeconds,
    collections: [{ externalId: collectionId.trim(), collectionKind }],
    watchComments,
  }
  const submit = () => {
    if (!canSubmit) return
    if (initial) {
      updateConnection.mutate(
        { connectionId: initial.id, input: { ...input, expectedRevision: initial.revision } },
        { onSuccess: () => onOpenChange(false), onError: (error) => toast(error.message, { tone: 'danger' }) },
      )
    } else {
      createConnection.mutate(input, {
        onSuccess: (result) => {
          trackSourceEvent('source.connection_created', result.connection)
          onOpenChange(false)
        },
        onError: (error) => toast(error.message, { tone: 'danger' }),
      })
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-slot="source-add-dialog">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit source' : 'Add a source'}</DialogTitle>
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

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="source-collection-id">Configured collection ID</Label>
            <Input
              id="source-collection-id"
              data-slot="source-collection-id"
              placeholder="Notion page or database ID"
              value={collectionId}
              onChange={(event) => setCollectionId(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="source-collection-kind">Collection kind</Label>
            <select
              id="source-collection-kind"
              data-slot="source-collection-kind"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={collectionKind}
              onChange={(event) => setCollectionKind(event.target.value as 'database' | 'page-tree')}
            >
              <option value="page-tree">Page tree</option>
              <option value="database">Database</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="source-interval">Interval, seconds</Label>
            <Input
              id="source-interval"
              data-slot="source-interval"
              type="number"
              min={minimumInterval}
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(Number(event.target.value))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="source-mode">Mode</Label>
            <select
              id="source-mode"
              data-slot="source-mode"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={mode}
              onChange={(event) => setMode(event.target.value as 'mirror' | 'archived')}
            >
              <option value="mirror">Mirror</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        </div>

        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          Enabled
        </label>
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <input type="checkbox" checked={watchComments} onChange={(event) => setWatchComments(event.target.checked)} />
          Watch comments
        </label>

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
            disabled={!canSubmit || mutationPending}
            onClick={submit}
          >
            {initial ? 'Save connection' : 'Create connection'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SourceBrowser({ connection, onClose }: { connection: SourceConnectionWire; onClose: () => void }) {
  const documents = useSourceDocuments(connection.id)
  const comments = useSourceComments(connection.id, connection.watchComments)
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const selected = documents.data?.documents.find((document) => document.docId === selectedDocId) ?? null
  const detail = useSourceDocument(connection.id, selectedDocId ?? '', selectedDocId !== null)
  const adopt = useAdoptSourceDocument()
  const resolve = useResolveSourceConflict()

  const mutateDocument = (action: 'keep-local' | 'take-remote') => {
    if (!selected) return
    resolve.mutate(
      { connectionId: connection.id, docId: selected.docId, input: { action } },
      {
        onSuccess: () => trackSourceEvent('source.conflict_resolved', connection, { action }),
        onError: (error) => toast(error.message, { tone: 'danger' }),
      },
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-slot="source-browser" className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{connection.name} documents</DialogTitle>
          <DialogDescription>Mirrored content, provenance, comments, and conflict actions.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[minmax(180px,0.7fr)_minmax(0,1.5fr)]">
          <div>
            <h3 className="mb-2 text-xs font-semibold text-foreground">Documents</h3>
            {documents.isPending ? <p className="text-[13px] text-soft-foreground">Loading documents…</p> : null}
            <ul data-slot="source-document-list" className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {(documents.data?.documents ?? []).map((document: SourceDocumentListItem) => (
                <li key={document.docId}>
                  <button
                    type="button"
                    data-action="source-document-select"
                    data-doc-id={document.docId}
                    aria-pressed={selectedDocId === document.docId}
                    onClick={() => setSelectedDocId(document.docId)}
                    className={cn(
                      'w-full rounded-md border px-2.5 py-2 text-left text-[12px]',
                      selectedDocId === document.docId ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted',
                    )}
                  >
                    <span className="block font-medium text-foreground">{document.title}</span>
                    <span className="text-soft-foreground">{document.state} · {document.docType}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div data-slot="source-document-detail" className="min-w-0 rounded-md border border-border p-3">
            {!selected ? (
              <p className="text-[13px] text-soft-foreground">Select a document to inspect it.</p>
            ) : detail.isPending ? (
              <p className="text-[13px] text-soft-foreground">Loading document…</p>
            ) : detail.data?.document ? (
              <DocumentDetail
                document={detail.data.document}
                comments={comments.data?.comments.filter((comment) => comment.docId === selected.docId) ?? []}
                onAdopt={() => adopt.mutate(
                  { connectionId: connection.id, docId: selected.docId },
                  {
                    onSuccess: () => trackSourceEvent('source.document_adopted', connection),
                    onError: (error) => toast(error.message, { tone: 'danger' }),
                  },
                )}
                onResolve={mutateDocument}
                mutating={adopt.isPending || resolve.isPending}
              />
            ) : (
              <p className="text-[13px] text-soft-foreground">Document is no longer available.</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DocumentDetail({
  document,
  comments,
  onAdopt,
  onResolve,
  mutating,
}: {
  document: NonNullable<ReturnType<typeof useSourceDocument>['data']>['document']
  comments: Array<{ id: string; body: string; createdAt: string; author?: string }>
  onAdopt: () => void
  onResolve: (action: 'keep-local' | 'take-remote') => void
  mutating: boolean
}) {
  if (!document) return null
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{document.title}</h3>
        <a className="text-[12px] text-primary underline" href={document.url} target="_blank" rel="noreferrer">Open source</a>
      </div>
      <dl data-slot="source-provenance" className="grid gap-x-3 gap-y-1 text-[11.5px] sm:grid-cols-2">
        <dt className="text-soft-foreground">Origin</dt><dd>{document.origin}</dd>
        <dt className="text-soft-foreground">State</dt><dd>{document.state}</dd>
        <dt className="text-soft-foreground">Mirrored</dt><dd>{document.mirroredAt}</dd>
        <dt className="text-soft-foreground">External ID</dt><dd>{document.externalId}</dd>
      </dl>
      {document.lossy.length > 0 ? (
        <p data-slot="source-lossiness" className="text-[12px] text-pending-strong">Lossy conversion: {document.lossy.join(', ')}</p>
      ) : null}
      {document.state === 'conflict' ? (
        <p data-slot="source-conflict-evidence" className="text-[12px] text-pending-strong">
          The incoming remote body remains in the source conflicts folder. Keep local preserves this body; Take remote saves it under conflicts before replacement.
        </p>
      ) : null}
      <pre data-slot="source-document-body" className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-[12px]">{document.body ?? ''}</pre>
      <div className="flex flex-wrap gap-1.5">
        {document.state === 'conflict' ? (
          <>
            <Button type="button" size="sm" data-action="source-conflict-keep-local" disabled={mutating} onClick={() => onResolve('keep-local')}>Keep local</Button>
            <Button type="button" size="sm" data-action="source-conflict-take-remote" disabled={mutating} onClick={() => onResolve('take-remote')}>Take remote</Button>
          </>
        ) : document.origin === 'remote' ? (
          <Button type="button" variant="outline" size="sm" data-action="source-adopt" disabled={mutating} onClick={onAdopt}>Adopt locally</Button>
        ) : null}
      </div>
      <section data-slot="source-comments" className="border-t border-border pt-3">
        <h4 className="mb-1 text-xs font-semibold text-foreground">Comments</h4>
        {comments.length === 0 ? <p className="text-[12px] text-soft-foreground">No mirrored comments.</p> : (
          <ul className="flex flex-col gap-2">
            {comments.map((comment) => <li key={comment.id} className="rounded bg-muted p-2 text-[12px]"><span className="font-medium">{comment.author ?? 'Unknown author'}</span> <time dateTime={comment.createdAt}>{comment.createdAt}</time><p>{comment.body}</p></li>)}
          </ul>
        )}
      </section>
    </div>
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
