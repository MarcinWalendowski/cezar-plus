import { useCallback, useEffect, useState } from 'react'
import { Link as WorkspaceLink } from 'react-router'

import { useSendMessage } from '@/api/queries'
import type { ApiRun } from '@loki-labs/cezar-plus-api-client'
import { Composer } from '@/components/composer/composer'

import { useContinueAction } from './follow-up-engine'
import { reapTaskDrafts, readTaskDraft, writeTaskDraft } from './task-drafts'

/**
 * The thread's composer, and the draft that outlives it (spec
 * `.ai/specs/2026-08-21-per-task-prompt-drafts.md`).
 *
 * Extracted from `ThreadView` for one reason: it is mounted `key={run.id}`, like the agents and
 * plan docks beside it. `/tasks/A` → `/tasks/B` re-renders the SAME route element and `useRun` is
 * a plain query that never suspends, so with both queries warm nothing unmounts — and before this
 * key, `Composer`'s internal text followed you from one task to the next. Keying also makes the
 * draft read a genuine mount-time read, so there is never a frame painting the previous task's
 * words; an effect-based reset would render exactly that frame.
 *
 * The write is synchronous, inside `onValueChange`. There is no debounce, so at the instant any
 * navigation begins the store is already current and there is nothing to flush.
 */
export function ThreadComposer({
  run,
  sessionOpen,
  queued,
  getMentionCandidates,
}: {
  run: ApiRun
  /** running | waiting — the engine owns a live session, so the composer can deliver to it. */
  sessionOpen: boolean
  /** #472 — a queued run has not started, so its prompt is still authorable. */
  queued: boolean
  getMentionCandidates: () => string[]
}) {
  // The fourth authorable state: a closed run whose last session can be reopened. Continue takes a
  // prompt, so the composer stays live and its send IS that Continue.
  const continueAction = useContinueAction(run)
  // Reroutable (site 3 for a live/queued send, site 4/5 for a continuation): the CLIENT cannot see
  // the accounts store or the project route, so no client-side predicate over provider status is
  // right — the server's answer to the submission is authoritative
  // (`.ai/specs/2026-08-25-logged-out-account-fallback.md`, Solution 6). A closed run with a
  // recorded session to reopen stays continuable regardless of what provider discovery currently
  // reports; the composer attempts the submission and renders the server's own refusal, if any.
  const continuable = !sessionOpen && !queued && continueAction.available
  const sendMessage = useSendMessage(run.id)

  // Mount-time read: this component is keyed by run id, so a task switch is a real mount and the
  // first painted frame already carries the right task's words.
  const [text, setText] = useState(() => readTaskDraft('prompt', run.id))
  const onValueChange = useCallback(
    (next: string) => {
      setText(next)
      // Every internal edit flows through here — typing, `/` completions, dictation, the optimistic
      // clear on send (which REMOVES the entry) and the restore after a rejected send (which puts
      // the words back, in the store as well as the box).
      writeTaskDraft('prompt', run.id, next)
    },
    [run.id],
  )
  // One bounded pass per thread open. The composer is the box that mounts on every thread.
  useEffect(() => reapTaskDrafts(), [])

  return (
    <Composer
      value={text}
      onValueChange={onValueChange}
      onSubmit={
        continuable
          ? (submitted, images) => continueAction.continueWith(submitted, images)
          : (submitted, images) => sendMessage.mutateAsync({ text: submitted, images })
      }
      disabled={!sessionOpen && !queued && !continuable}
      // Only reachable now by a closed run with NO session to resume — which is exactly the one
      // case where Continue is not on offer either. Left honest rather than rewritten: "closed" is
      // all such a run can be told.
      disabledReason="Session closed — no session to resume."
      // The engine pills ride the enabled footer, so the picked runner/model and the typed prompt
      // reach `POST /continue` in one request. `continueAction.reason` is ADVISORY now, not a
      // gate: it names a provider problem the server may still route around (a pool member, a
      // fallback), so it replaces the pills with a way to fix it rather than blocking the send.
      footerEnd={
        continuable ? (
          continueAction.reason && !continueAction.providerPending ? (
            <WorkspaceLink
              to="/settings/providers"
              className="text-xs font-medium text-foreground underline underline-offset-4"
            >
              Configure providers
            </WorkspaceLink>
          ) : (
            continueAction.pills
          )
        ) : undefined
      }
      // Continuing with nothing typed is the legacy one-click Continue.
      allowEmptySubmit={continuable}
      sendAriaLabel={continuable ? 'Continue' : 'Send'}
      placeholder={
        queued ? 'Add to the prompt — sent when the run starts…'
        : continuable ? 'Continue — add a prompt, or send to just reopen the session…'
        : run.status === 'waiting' ? 'Reply — / for skills, @ for files…'
        : 'Message the agent — / for skills, @ for files…'
      }
      autocompleteSkills
      quickReplies
      getMentionCandidates={getMentionCandidates}
    />
  )
}
