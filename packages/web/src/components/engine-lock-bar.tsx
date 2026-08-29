import { useMutation, useQueryClient } from '@tanstack/react-query'

import { putWorkspaceConfig } from '@/api/client'
import { useProviderStatus, useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import { LOCKABLE_RUNNERS, type LockableRunner } from '@loki-labs/better-cezar-api-client'
import { toast } from '@/components/ui/toaster'
import { providerStatusFor } from '@/lib/provider-status'
import { cn } from '@/lib/utils'

const RUNNER_LABEL: Record<LockableRunner, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

export interface EngineLockOption {
  /** `null` is Auto — the lock cleared, today's byte-for-byte behaviour. */
  value: LockableRunner | null
  label: string
}

/**
 * `.ai/specs/2026-08-29-global-provider-toggle.md`, D9: the global engine lock bar — pinned to
 * the top of every cockpit screen, and mirrored (via `EngineLockBarContainer` below) in
 * Settings → Providers. One value, two renderers.
 *
 * Presentational by construction, `value`/`options`/`onChange` only, exactly like `AppShell`
 * itself: this is the component `AppShell`'s `globalBar` slot is filled WITH (never mounted by
 * `AppShell` directly), so it must be unit-testable with no `QueryClient` at all — see D9's own
 * "row 2 is a SLOT, not a mounted component" ruling.
 *
 * Compact by construction (R7): 36px tall, so the row it adds costs as little as a control on
 * every screen can.
 */
export function EngineLockBar({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: LockableRunner | null
  options: readonly EngineLockOption[]
  onChange: (value: LockableRunner | null) => void
  disabled?: boolean
}) {
  return (
    <div
      data-slot="engine-lock-bar"
      className="flex h-9 items-center gap-2 border-b border-border bg-card px-3"
    >
      <span className="text-[11px] font-medium text-soft-foreground">Engine</span>
      <div
        role="radiogroup"
        aria-label="Global engine lock"
        className="inline-flex items-center gap-0.5 rounded-md bg-muted p-[3px]"
      >
        {options.map((option) => {
          const optionKey = option.value ?? 'auto'
          const selected = option.value === value
          return (
            <button
              key={optionKey}
              type="button"
              role="radio"
              aria-checked={selected}
              data-slot="engine-lock-option"
              data-value={optionKey}
              data-state={selected ? 'active' : undefined}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={cn(
                'rounded-sm px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
                selected && 'bg-card font-semibold text-foreground shadow-xs',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The data half. Reads `GET /workspace/config` for the current `runnerLock` and `GET
 * /providers/status` for which segments to offer — D9: "only the ones that are discovered and
 * not in `disabledProviders`", so a machine with codex disabled (or never installed) shows only
 * `Auto · Claude`, with no second hardcoded provider list to fall out of step with the contract's
 * `LOCKABLE_RUNNERS`. Issues `PUT /workspace/config { runnerLock }` on a click; `Auto` sends
 * `null`.
 *
 * Mounted twice — as `AppShellContainer`'s `globalBar` and inside Settings → Providers
 * (`ProviderSettings`, `.ai/specs/2026-08-21-one-settings-area.md`'s `appliesTo: 'workspace'`
 * convention) — both going through this same container, the same query key and the same mutation,
 * so there is exactly one place this control's data logic can drift.
 */
export function EngineLockBarContainer() {
  const config = useWorkspaceConfig()
  const providers = useProviderStatus()
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: (runnerLock: LockableRunner | null) => putWorkspaceConfig({ runnerLock }),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  // The row this renders into (`AppShell`'s `data-slot="global-bar"`) is always present — this
  // component simply has nothing honest to show before the config has loaded once.
  if (!config.data) return null

  const options: EngineLockOption[] = [
    { value: null, label: 'Auto' },
    ...LOCKABLE_RUNNERS.filter((runner) => {
      const row = providerStatusFor(providers.data, runner)
      // "Discovered": the provider is actually present on this machine (not `not-installed`),
      // and not turned off in `disabledProviders` (`enabled !== false`). `undefined` — status
      // hasn't answered yet — renders no segment rather than one nobody has confirmed.
      return row !== undefined && row.status !== 'not-installed' && row.enabled !== false
    }).map((runner) => ({ value: runner, label: RUNNER_LABEL[runner] })),
  ]

  return (
    <EngineLockBar
      value={config.data.runnerLock}
      options={options}
      disabled={save.isPending}
      onChange={(next) => save.mutate(next)}
    />
  )
}
