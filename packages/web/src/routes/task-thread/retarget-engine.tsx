import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { retargetRun } from '@/api/client'
import { queryKeys, useConfig, useEngineAdvisory, useRunnerModels } from '@/api/queries'
import type { ApiRun, Runner } from '@loki-labs/better-cezar-api-client'
import { PickerPill, RunnerPill } from '@/components/picker-pill'
import { modelsForRunner, modelCatalogStatus, resolveModel } from '@/routes/new-task-form'
import { useContinuationProvider } from './continuation-provider'
import { runActionFlags } from './run-actions'

/** What the thread needs to offer "Run on…" for a PARKED task. */
export interface RetargetAction {
  /** Is this task in a state that can be moved at all? (`runActionFlags.retarget`.) */
  available: boolean
  /** Whether provider discovery currently permits starting on the chosen engine. */
  canRetarget: boolean
  /** Fixed recovery copy when no provider is usable. */
  reason?: string
  providerPending: boolean
  /** The runner + model pills — which engine the task moves to. */
  pills: ReactNode
  /** Every runner this host can start, and the one the task is on now — for a caller that offers
   *  the choice as a menu instead of as pills (the header's "Run on…"). */
  runners: readonly Runner[]
  currentRunner: Runner
  /** True while the move is in flight. */
  pending: boolean
  /**
   * Move the task. REJECTS with the server's own message rather than toasting itself, so the
   * caller can show why — most usefully the 409 for a task that started while the menu was open,
   * which is a race a person hits by pressing this just as a slot frees.
   *
   * `runner` names an engine directly, bypassing the pills, and deliberately sends NO model: a
   * one-click "run this on codex" cannot know which codex model the user wants, and Phase 2
   * re-resolves the ladder for the new backend. Omit it to send whatever the pills are showing.
   */
  retarget: (runner?: Runner) => Promise<unknown>
}

/**
 * "Run on…" — the parked-task counterpart to `useContinueAction`
 * (spec `.ai/specs/2026-08-23-retarget-task-to-another-engine.md`, Phase 5).
 *
 * Built on the SAME pieces as the follow-up composer and `/new`: `RunnerPill`/`PickerPill`,
 * `modelsForRunner`/`resolveModel`, `useRunnerModels`, `useContinuationProvider`. That is the
 * point — one engine picker in the product, not three. A second implementation would drift on
 * exactly the details that are invisible until they are wrong: which models a backend offers,
 * what "auto" resolves to, and whether a locked-models workspace may pin one at all.
 *
 * The one deliberate difference from `useContinueAction` is that there is no draft: a parked task
 * has nothing to say to, so this posts only the engine choice. It is a hook rather than a button
 * for the same reason as its sibling — the pills' state has to live with whatever renders them.
 */
export function useRetargetAction(run: ApiRun): RetargetAction {
  const queryClient = useQueryClient()
  const available = runActionFlags(run).retarget
  const config = useConfig()
  const advisory = useEngineAdvisory()
  // null = "not touched". An untouched pill is NOT sent, so the server keeps what the run has —
  // a person who opens this to change the runner does not silently also re-pin a model they never
  // looked at.
  const [pickedRunner, setPickedRunner] = useState<Runner | null>(null)
  const [pickedModel, setPickedModel] = useState<string | null>(null)

  const continuation = useContinuationProvider(run, pickedRunner)
  const { runners, canContinue, currentRunner, runner } = continuation
  const catalog = useRunnerModels(runner, available)
  const modelsLocked = config.data?.modelsLocked === true
  const runnerChanged = runner !== currentRunner
  const modelDefaults =
    !modelsLocked && !runnerChanged && run.model
      ? { ...config.data?.defaultModels, [runner]: run.model }
      : config.data?.defaultModels
  const effectivePickedModel = modelsLocked ? null : pickedModel
  const models = modelsForRunner(runner, catalog.data, [effectivePickedModel, modelDefaults?.[runner]])
  const model = resolveModel(effectivePickedModel, runner, modelDefaults, catalog.data)

  const mutation = useMutation({
    mutationFn: (override?: Runner) => {
      if (!canContinue) {
        return Promise.reject(new Error(continuation.reason ?? 'Connect an agent provider to continue.'))
      }
      if (override) return retargetRun(run.id, { runner: override })
      return retargetRun(run.id, {
        runner: continuation.runnerOverride,
        model: !modelsLocked && pickedModel !== null ? model : undefined,
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })

  return {
    available,
    canRetarget: canContinue,
    reason: continuation.reason,
    providerPending: continuation.providerPending,
    pending: mutation.isPending,
    pills: (
      <div data-slot="retarget-engine" className="flex flex-wrap items-center gap-1.5">
        {runners.length > 1 ? (
          <RunnerPill
            runners={runners}
            value={runner}
            advisory={advisory}
            onPick={(next) => {
              setPickedRunner(next)
              setPickedModel(null) // a runner switch invalidates the previous model pick
            }}
          />
        ) : null}
        <PickerPill
          slot="retarget-model-pill"
          ariaLabel="Model"
          label={models.find((m) => m.id === model)?.label ?? 'auto'}
          value={model}
          readOnly={modelsLocked}
          disabledHint="Model selection is locked to native coding-agent settings."
          onPick={(next) => setPickedModel(next)}
          options={models.map((m) => ({ value: m.id, label: m.label, desc: m.desc }))}
          status={modelCatalogStatus(runner, catalog.data, catalog.isError)}
        />
      </div>
    ),
    runners,
    currentRunner,
    retarget: (override?: Runner) => mutation.mutateAsync(override),
  }
}
