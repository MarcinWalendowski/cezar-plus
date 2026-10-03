import type { UiState } from '@loki-labs/cezar-plus-api-client'

/**
 * What a start surface runs: a named workflow or a single skill.
 *
 * Here rather than beside the composer's own form rules (`routes/new-task-form.ts`, which
 * re-exports both) because the shared source picker and the automations editor need them too, and
 * a `components/` module must not reach into a `routes/` one. The shape is the one the server's
 * `ui-state.json` stores in `recentSources`, so persistence needs no mapping.
 */
export type TaskSource = NonNullable<UiState['recentSources']>[number]

/** The zero-config built-in used when no source is picked. */
export const QUICK_TASK = 'quick-task'
