import * as React from 'react'
import { HardDriveIcon } from 'lucide-react'

import type { BackupOverviewResponse, BackupSnapshot } from '@loki-labs/better-cezar-api-client'
import { ApiError } from '@/api/client'
import {
  useGcWorkspaceBackup,
  useRestoreWorkspaceBackup,
  useRunWorkspaceBackup,
  useVerifyWorkspaceBackup,
  useWorkspaceBackup,
  useWorkspaceBackupSnapshots,
} from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Global settings → Backup (spec `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`,
 * `CEZ_BACKUP=1`): the cockpit for the provider-agnostic, incremental, client-side-encrypted
 * backup of the durable platform corpus.
 *
 * Registered UNCONDITIONALLY in `registry.tsx` with no `capability:` field, on the `account`
 * section precedent — `capabilitiesSchema` deliberately carries no `backup` key (the flag-off
 * `/api/v1/health` body must stay byte-identical), so there is no synchronous capability a
 * registry-level gate could read. Visibility instead lives HERE, as an async probe: this section
 * reads `GET /api/v1/backup` and renders the "off" state when `CEZ_BACKUP` is unset, the cockpit
 * (`BackupCockpit`) when it is on.
 *
 * **Phase 8** fills in the ON-state cockpit the Phase 1 scaffold left as a placeholder: provider
 * summary, last-run status, coverage, run/verify/gc actions and the snapshot list with restore.
 * There is deliberately no provider-config FORM here — the spec's Config section is explicit that
 * `~/.cezar/backup.json` + env (`CEZ_BACKUP_KEY`, S3 credentials) is the only way to configure a
 * provider, and there is no write route for it (cezar law: env for configuration). The cockpit
 * only ever names the file and restarts as the way to change it.
 */
export function BackupSection() {
  const backup = useWorkspaceBackup()

  if (backup.isLoading) {
    return (
      <p data-slot="backup-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading…
      </p>
    )
  }

  if (!backup.data?.enabled) {
    return (
      <CenteredState
        icon={<HardDriveIcon />}
        tone="neutral"
        title="Backups are off"
        subtitle="Set CEZ_BACKUP=1 and restart cezar to configure an encrypted, incremental backup of the platform corpus to S3 (R2/S3/B2/MinIO) or a local disk."
        heading="h2"
      />
    )
  }

  return <BackupCockpit overview={backup.data} />
}

/** `18.4 MB` / `212 KB`. Sizes are for a human deciding whether to look before committing —
 *  matches `add-project-dialog.tsx`'s local helper of the same name, kept as its own copy since
 *  neither file exports one. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function BackupCockpit({ overview }: { overview: BackupOverviewResponse }) {
  const snapshotsQuery = useWorkspaceBackupSnapshots()
  const run = useRunWorkspaceBackup()
  const verify = useVerifyWorkspaceBackup()
  const gc = useGcWorkspaceBackup()

  const snapshots = snapshotsQuery.data?.snapshots ?? []

  return (
    <div
      data-slot="backup-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <section className="flex flex-col gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Provider</h2>
          <p className="text-[13px] text-muted-foreground">
            Set in <code>~/.cezar/backup.json</code> plus env (<code>CEZ_BACKUP_KEY</code>, and
            the provider&apos;s own credential vars) — there is no in-app form for it; edit the
            file and restart cezar to change the provider or key.
          </p>
        </div>
        {overview.provider ? (
          <div data-slot="backup-provider" className="flex items-center gap-2 text-[13px] text-foreground">
            <Badge variant="outline" className="uppercase">
              {overview.provider.kind}
            </Badge>
            <span>{overview.provider.label}</span>
          </div>
        ) : (
          <p data-slot="backup-no-provider" className="text-[13px] text-soft-foreground">
            No provider configured yet.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-foreground">Last run</h2>
        {overview.lastRun ? (
          <p data-slot="backup-last-run" className="text-[13px] text-muted-foreground">
            {new Date(overview.lastRun.createdAt).toLocaleString()} — snapshot{' '}
            {overview.lastRun.snapshotId}, {overview.lastRun.uploaded} uploaded,{' '}
            {overview.lastRun.skipped} skipped ({formatBytes(overview.lastRun.bytes)}).
          </p>
        ) : (
          <p data-slot="backup-never-run" className="text-[13px] text-soft-foreground">
            Never run.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-foreground">Coverage</h2>
        {overview.includeSummary ? (
          <p data-slot="backup-coverage" className="text-[13px] text-muted-foreground">
            {overview.includeSummary.homeFiles} home file
            {overview.includeSummary.homeFiles === 1 ? '' : 's'} across{' '}
            {overview.includeSummary.projectCount} project
            {overview.includeSummary.projectCount === 1 ? '' : 's'}, {overview.snapshotCount}{' '}
            snapshot{overview.snapshotCount === 1 ? '' : 's'} stored.
          </p>
        ) : (
          <p className="text-[13px] text-soft-foreground">Not yet known — run a backup first.</p>
        )}
      </section>

      <section className="flex flex-col gap-2.5 border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-foreground">Actions</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'Backing up…' : 'Back up now'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={verify.isPending}
            onClick={() => verify.mutate()}
          >
            {verify.isPending ? 'Verifying…' : 'Verify'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={gc.isPending}
            onClick={() => gc.mutate()}
          >
            {gc.isPending ? 'Collecting…' : 'Collect garbage'}
          </Button>
        </div>

        {run.error ? (
          <p data-slot="backup-run-error" className="text-[13px] text-danger">
            {run.error.message}
          </p>
        ) : null}
        {run.data ? (
          <p data-slot="backup-run-result" className="text-[12px] text-soft-foreground">
            Snapshot {run.data.snapshotId}: {run.data.uploaded} uploaded, {run.data.skipped}{' '}
            skipped ({formatBytes(run.data.bytes)}).
          </p>
        ) : null}

        {verify.error ? (
          <p data-slot="backup-verify-error" className="text-[13px] text-danger">
            {verify.error.message}
          </p>
        ) : null}
        {verify.data ? (
          <p data-slot="backup-verify-result" className="text-[12px] text-soft-foreground">
            Key {verify.data.keyOk ? 'OK' : 'FAILED'}, provider{' '}
            {verify.data.providerOk ? 'reachable' : 'unreachable'}, sample round-trip{' '}
            {verify.data.sampleRoundTrip ? 'passed' : 'failed'}.
          </p>
        ) : null}

        {gc.error ? (
          <p data-slot="backup-gc-error" className="text-[13px] text-danger">
            {gc.error.message}
          </p>
        ) : null}
        {gc.data ? (
          <p data-slot="backup-gc-result" className="text-[12px] text-soft-foreground">
            Pruned {gc.data.prunedBlobs} blob{gc.data.prunedBlobs === 1 ? '' : 's'}, freed{' '}
            {formatBytes(gc.data.freedBytes)}.
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-foreground">Snapshots</h2>
        {snapshotsQuery.isPending ? (
          <p className="text-[13px] text-soft-foreground">Loading…</p>
        ) : snapshots.length === 0 ? (
          <p data-slot="backup-snapshots-empty" className="text-[13px] text-soft-foreground">
            No snapshots yet.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {snapshots.map((snapshot) => (
              <SnapshotRow key={snapshot.id} snapshot={snapshot} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function SnapshotRow({ snapshot }: { snapshot: BackupSnapshot }) {
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  return (
    <div
      data-slot="backup-snapshot-row"
      data-snapshot-id={snapshot.id}
      className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3.5 py-3"
    >
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-foreground">{snapshot.id}</p>
        <p className="text-[12px] text-soft-foreground">
          {new Date(snapshot.createdAt).toLocaleString()} — {formatBytes(snapshot.sizeBytes)},{' '}
          {snapshot.blobCount} blob{snapshot.blobCount === 1 ? '' : 's'}
        </p>
      </div>
      <Button type="button" variant="danger-ghost" size="sm" onClick={() => setConfirmOpen(true)}>
        Restore
      </Button>
      <RestoreDialog snapshot={snapshot} open={confirmOpen} onOpenChange={setConfirmOpen} />
    </div>
  )
}

/**
 * The restore confirm, fail-closed and two-step (spec N6 + the phase's explicit ask): the first
 * attempt always goes out with `force: false`. `runRestore` on the server refuses a non-empty
 * target with a `409` whose `{error}` names it ("… refusing to overwrite N existing file(s) …",
 * `backup/restore.ts`) — that specific refusal, and only that one, is what unlocks the second,
 * distinctly-labeled "Overwrite existing files" confirm, which retries with `force: true`. Any
 * other failure (key mismatch, no backup found, provider unreachable) just shows the error and
 * leaves the plain "Restore" retry in place — never routes those into the force path.
 *
 * `force: true` is only ever sent from the second button's own `onClick`, never as a fallback or
 * an automatic retry — a caller cannot reach an overwrite without both attempts happening in the
 * browser, in order, with the refusal shown in between.
 */
function RestoreDialog({
  snapshot,
  open,
  onOpenChange,
}: {
  snapshot: BackupSnapshot
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const restore = useRestoreWorkspaceBackup()

  // Fresh mutation state every time the dialog opens — a stale error or result from a previous
  // open (of this row or another) must never leak into a new confirmation.
  React.useEffect(() => {
    if (open) restore.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, snapshot.id])

  const refusedOverwrite =
    restore.error instanceof ApiError && /refusing to overwrite/i.test(restore.error.message)

  const attempt = (force: boolean) =>
    restore.mutate({ snapshotId: snapshot.id, force }, { onSuccess: () => onOpenChange(false) })

  return (
    <Dialog open={open} onOpenChange={(next) => !restore.isPending && onOpenChange(next)}>
      <DialogContent data-slot="restore-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Restore snapshot {snapshot.id}?</DialogTitle>
          <DialogDescription>
            Fetches, decrypts and checksum-verifies every blob in this snapshot, then writes it
            into place. A target that already has files in it is refused unless you explicitly
            choose to overwrite them.
          </DialogDescription>
        </DialogHeader>

        {restore.error ? (
          <p data-slot="restore-dialog-error" className="text-[13px] text-danger">
            {restore.error.message}
          </p>
        ) : null}

        <DialogFooter className="sm:items-center sm:justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={restore.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {refusedOverwrite ? (
            <Button
              type="button"
              data-slot="restore-dialog-force-confirm"
              variant="danger-ghost"
              disabled={restore.isPending}
              onClick={() => attempt(true)}
            >
              {restore.isPending ? 'Restoring…' : 'Overwrite existing files'}
            </Button>
          ) : (
            <Button
              type="button"
              data-slot="restore-dialog-confirm"
              disabled={restore.isPending}
              onClick={() => attempt(false)}
            >
              {restore.isPending ? 'Restoring…' : 'Restore'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
