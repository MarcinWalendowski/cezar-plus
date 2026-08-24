/** Tarball bundle check — the pure half of `scripts/check-pack.mjs`.
 *
 *  Phase R1 of the cockpit redesign shipped an npm tarball with no UI in it
 *  (`files` listed the sources, not the Vite build). This module pins that bug
 *  class: given the file list `npm pack --dry-run --json` reports, decide
 *  whether the package would ship a working cockpit. Kept dependency-free and
 *  side-effect-free so the decision is unit-testable; the script owns the
 *  `npm pack` invocation and the exit code.
 */

/** The three CEZ_DRY_RUN mocks that must ship in `scripts/` — one per backend
 *  (`.ai/specs/2026-08-24-codex-dry-run-mock.md` D3). A tarball missing any of them ships a
 *  `CEZ_DRY_RUN` that silently spawns the real CLI for that backend instead of the mock. */
const REQUIRED_MOCKS = ['scripts/mock-claude.mjs', 'scripts/mock-pi-rpc.mjs', 'scripts/mock-codex-app-server.mjs'];

/** Human-readable problems with a would-be tarball; empty array = publishable.
 *
 *  Requirements (spec `.ai/specs/2026-07-14-cockpit-ui-redesign.md`, Serving):
 *  - `web/dist/index.html` — the built shell every GET serves.
 *  - at least one `web/dist/assets/*` file — the hashed JS/CSS bundles; an
 *    index.html alone renders a blank page.
 *  - each of `REQUIRED_MOCKS` — the CEZ_DRY_RUN mocks (spec `2026-08-24-codex-dry-run-mock.md`).
 */
export function findPackGaps(packedFiles: readonly string[]): string[] {
  const gaps: string[] = [];
  if (!packedFiles.includes('web/dist/index.html')) {
    gaps.push('web/dist/index.html is missing — the tarball would ship no UI shell (run `npm run build:web`)');
  }
  if (!packedFiles.some((f) => f.startsWith('web/dist/assets/') && f.length > 'web/dist/assets/'.length)) {
    gaps.push('no web/dist/assets/* bundle in the tarball — the shell would load with no JS/CSS');
  }
  for (const mock of REQUIRED_MOCKS) {
    if (!packedFiles.includes(mock)) {
      gaps.push(`${mock} is missing — CEZ_DRY_RUN would spawn the real CLI for that backend instead of the mock`);
    }
  }
  return gaps;
}
