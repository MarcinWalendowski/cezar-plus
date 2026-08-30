/**
 * The one sentence a cross-project board says when it has nothing to show because the capability
 * is off.
 *
 * It lives in one place because it stopped being a constant. `workspaceViews` used to be off unless
 * `CEZ_WORKSPACE_VIEWS=1`, so "set the flag and restart" was true wherever it appeared. Since
 * 2026-08-16 the flag defaults **on**, and there are now two ways to arrive at the off state that
 * need opposite advice:
 *
 * - `CEZ_WORKSPACE_VIEWS=0` — someone switched it off, and unsetting it brings the board back.
 * - `CEZ_SINGLE_PROJECT=1` — a single-project cockpit reports the capability false *regardless* of
 *   the flag (`server/capabilities.ts`), so telling that user to set `CEZ_WORKSPACE_VIEWS=1` is
 *   advice that cannot work. They would set it, restart, see the same blank page, and have no way
 *   to tell what happened. That failure predates the default flip; it was simply unreachable before,
 *   because nobody in single-project mode had a reason to be reading this sentence.
 */
export function workspaceViewsOffSubtitle(singleProject: boolean | undefined): string {
  return singleProject === true
    ? 'This cockpit runs one project (CEZ_SINGLE_PROJECT=1), so there is nothing to show across projects.'
    : 'Cross-project views are on by default — this server has them switched off with CEZ_WORKSPACE_VIEWS=0. Unset it and restart cezar-plus.'
}
