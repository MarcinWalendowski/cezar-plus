import { HardDriveIcon } from 'lucide-react'

import { useWorkspaceBackup } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'

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
 * when it is on.
 *
 * **This is the SCAFFOLD (Phase 1).** The on-state is a placeholder; Phase 8 fills it with the
 * provider config form, last-run status, snapshot list and restore controls. The off-state is
 * final.
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

  // Phase 8 replaces this placeholder with the provider config, last-run status, snapshot list and
  // restore controls. Kept intentionally minimal so the scaffold ships inert.
  return (
    <CenteredState
      icon={<HardDriveIcon />}
      tone="neutral"
      title="Backup"
      subtitle="The backup cockpit arrives in a later phase. Backups run on a schedule once a provider and encryption key are configured."
      heading="h2"
    />
  )
}
