import { useEffect, useState } from 'react'

import type { KnowledgeDocument } from '@loki-labs/better-cezar-api-client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

/**
 * `routes/knowledge/editor.tsx` (W1.10, central-hub PLAN, package table wave 1): the knowledge
 * document editor. **Presentational and prop-driven only** — no data fetching, no `PUT
 * /knowledge/:id` call inside this file. The caller (the cockpit shell, not owned here) performs
 * the mutation and hands back its outcome as props; this leaf only reflects state and calls
 * `onSave`. See `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` "UI/UX" → Leaves:
 * "sends `version`, renders a 409's server message verbatim, and never discards the user's edit
 * on conflict."
 *
 * Two controls this file exists to satisfy (Phases table, W1.10 row):
 *  1. **`version` is sent with every save** — `document.hash` is the sha256-of-exact-bytes
 *     `version` a stale-write 409 compares against (the same scheme `agent-config/files.ts`
 *     uses, reused here per the spec's Q7/agent-config precedent). It travels straight from the
 *     loaded document to `onSave`, never recomputed or guessed.
 *  2. **A 409 is rendered in the SERVER'S OWN WORDS**, not a generic "conflict" string like the
 *     agent-config editor's fixed "The file changed on disk…" — a stale-version 409, a
 *     read-only-root 409, and an `origin: 'remote'` "adopt first" 409 are different situations
 *     and the server already said which; paraphrasing would throw that away.
 *  3. **The draft is never reset in response to `error` or `saving`.** The only thing that
 *     re-seeds the draft is `document.id` changing — i.e. a different document loading, which is
 *     the one case a reset is actually correct. A conflict arriving mid-edit must never cost the
 *     user the paragraph they were typing.
 */

export interface DocumentEditorSaveInput {
  content: string
  version: string
}

export interface DocumentEditorError {
  status: number
  /** The server's own message, verbatim. Never wrapped, never replaced. */
  message: string
}

export interface DocumentEditorProps {
  document: Pick<KnowledgeDocument, 'id' | 'title' | 'body' | 'hash'>
  /** False for a read-only mount, or a mirrored document whose `source.origin` is `'remote'`
   *  (the spec's "409, adopt first" case) — the caller already knows this from `document.source`
   *  / the root's `writable` flag; this leaf just reflects the decision rather than re-deriving
   *  it, since re-deriving it here would be a second copy of server-side containment logic. */
  writable: boolean
  saving?: boolean
  /** The most recent save attempt's failure, or `null`/absent once there isn't one. This leaf
   *  never clears it on its own — only the caller can, typically by re-attempting the save. */
  error?: DocumentEditorError | null
  onSave: (input: DocumentEditorSaveInput) => void
  className?: string
}

export function DocumentEditor({
  document,
  writable,
  saving = false,
  error = null,
  onSave,
  className,
}: DocumentEditorProps) {
  const [draft, setDraft] = useState(document.body ?? '')

  // Re-seed ONLY when a different document loads. Deliberately NOT keyed on `error` or `saving` —
  // keying it on either is exactly how a conflict would silently eat the user's edit.
  useEffect(() => {
    setDraft(document.body ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id])

  const savedContent = document.body ?? ''
  const dirty = draft !== savedContent

  const save = () => {
    if (!writable || saving) return
    onSave({ content: draft, version: document.hash })
  }

  return (
    <div
      data-slot="knowledge-editor"
      data-writable={writable}
      className={cn('flex flex-col gap-2', className)}
    >
      {!writable && (
        <p data-slot="knowledge-editor-readonly" className="text-[12px] text-soft-foreground">
          Read-only — this document lives on a mount cezar does not write to, or it was mirrored
          from an external source and needs adopting before it can be edited here.
        </p>
      )}

      <Textarea
        data-slot="knowledge-editor-content"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        readOnly={!writable}
        aria-label={`${document.title} content`}
        className="min-h-[24rem] font-mono text-[13px]"
      />

      {error && (
        <div
          data-slot="knowledge-editor-error"
          data-status={error.status}
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
        >
          {error.message}
        </div>
      )}

      {writable && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDraft(savedContent)}
            disabled={!dirty || saving}
          >
            Revert
          </Button>
          {dirty && <span className="text-[12px] text-soft-foreground">Unsaved changes</span>}
        </div>
      )}
    </div>
  )
}
