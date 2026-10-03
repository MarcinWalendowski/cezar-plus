# Upstream sync fork integration

**Status:** Implemented · **Date:** 2026-10-03 · **Verified:** 2026-10-04

## TLDR

Integrate upstream `open-mercato/cezar` through `1b13522dd3642a4ea8331629b3680838164d2a2e`
(0.14.0) into the fork `MarcinWalendowski/cezar-plus`, starting at
`dc655ca14a52cfb353ca3b811ac0375f2303e3bc`. Preserve the fork's capabilities and identity,
verify the built application, and deliver one merge commit to `origin/main` only.

## Problem

The fork last incorporated upstream 0.10.0 (`1912f2f2`). Historical fork commits were
rewritten: Git finds no merge-base, although upstream `1912f2f2` and fork `0c966fc1`
have the identical tree `01a62368a97858f57103891fb4e824ab2e4071f1`. There are 136 later
upstream commits. An empty-base merge would misclassify existing files as independent
additions. A raw merge using the verified base has 154 conflicted paths.

## Solution

Use an isolated worktree. Normalize only upstream package specifiers to the fork's
`@loki-labs/cezar-plus*` names in temporary base/incoming trees, then perform a real
three-way merge against that verified historical snapshot. Resolve semantic conflicts
by retaining both intended behaviors. Record the actual upstream tip as the second
parent of the final merge commit, reconnecting histories without rewriting commits.
Keep temporary normalization objects out of the delivered ancestry.

## Architecture

- Retain knowledge/search, external sources and conflicts, notes/reports, auth/orgs,
  account pools/usage, cross-project runs, cluster replication/security and resource limits.
- Retain fork workflow models/effort, postconditions, build stamps and manual activation.
- Incorporate upstream runner, task dispatch, monitoring, cancellation, storage, attachment,
  tracker, dashboard, host telemetry, self-update and desktop changes.
- Keep fork package names, repo destinations, CLI aliases and empty default skills repos.
  Do not restore vendor banners, automatic upstream updater destinations or vendor skills.
- Preserve the fork's opt-in automation default (`CEZ_AUTOMATIONS=1`) while importing
  upstream scheduled/tracker triggers. Upstream's default-on change is deliberately adapted
  to the fork's documented protected default. Preserve desktop's independent 0.1.3 version.
- Cap both Changes file trees against the measured main scrollport height rather than
  the whole viewport. Runtime measurement found the imported viewport cap extended 20 px
  below the fork's scroller because of pinned shell chrome. The shell publishes one inherited
  height variable, updated with ResizeObserver without React rerenders; panes subtract their
  existing sticky offset and bottom gutter. Retain the viewport fallback before measurement.
  A tall task header also pushes the tree below its eventual sticky inset before scrolling.
  Attach a shared pane measurement through a callback ref after conditional loading. Clamp
  height to the smaller of the current space below the pane and the normal sticky-room
  ceiling, preventing growth feedback at the container end. Coalesce passive scroll/resize
  observations into animation frames, write only changed positive-layout measurements,
  and detach observers/listeners/frames when the pane unmounts. No React scroll state.
- Use a fork-specific desktop bundle identifier and release destinations. Disable desktop
  shell updates until fork signing is configured; never trust the upstream signing key.
  Generate native icon sizes from the existing fork `packages/web/public/cezar.svg`.
  Hosted self-update mutations must obey the fork's principal/org/admin authorization.
- Preserve existing protected contracts; add upstream schema/route changes consistently
  across contract, service, client and cockpit. Keep fork-specific schemas and capabilities.
- Retain both changelog records. Refresh release package versions together to 0.14.0 while
  retaining newer already-pinned dependency versions where upstream would downgrade them.
- Preserve upstream analytics events and fork analytics logging. No new product interaction
  is designed by the sync; use the existing analytics channels for imported features.

## Phases

1. Author audit/spec; obtain independent advisor review before implementation.
2. Stage the normalized three-way result with true conflict stages and original upstream
   merge parent. Save the conflict inventory and provenance under ignored QA artifacts.
3. Use at least five implementation/verification lanes with disjoint ownership:
   contracts; core runners; cockpit API/shell; cockpit routes; packaging/install/docs.
   Session model owns central server integration, workflow decisions and final gates;
   construction includes a separate workflow integration lane.
   At most three lanes run concurrently because four agent slots are available.
4. Run all gates sequentially, repair integration failures, execute browser/runtime E2E
   with screenshots and recording. Verify imported and retained capabilities together.
5. Refresh upstream/origin, account for any intervening commits, then create one merge
   commit and push the exact commit to `origin/main`. Sync task/changelog/knowledge with
   narrowly staged corpus files, reindex and confirm the catalog contains each new slug.

## Data Models

Plain JSON/NDJSON state remains readable. Retain fork fields and migration/read paths;
incorporate additive upstream run, dispatch, tracker, attachment and workspace fields.
No production state deletion or fixture registration in the operator's real registry.

## API Contracts

All endpoints remain under `/api/v1` and project aliases retain equivalent behavior.
Use Zod contract schemas and chained Hono builders. Contract parity, route inventory,
capability fixtures and package tests must include both fork and imported surfaces.

An empty registry lists the launch folder as an unregistered project. Explicit HTTP
registration saves that folder using its existing boot ID, applies the usual organization
claim guards, and reuses the boot context rather than opening another store. The internal
`registerProject` boot descriptor retains its default no-write behavior; a `persist: true`
option is used only for this explicit add gesture. Booting still never auto-registers it.
Verify registration twice, unchanged boot ID, one registry row and scoped reads through the
original boot store; retain the duplicate-root context refusal tests.

Filed-task receipts must link to the target project's standalone
`/p/:projectId/todos/:todoId` page, encoding each path segment independently. The old
`/tasks?fdetail=` dialog was replaced upstream. Preserve the fork's cross-project receipt
by navigating to the filed item's project rather than the launch project. Verify exact
scoped hrefs and segment escaping in unit coverage, then click a receipt for a non-launch
project in the browser and assert its actual filed-task detail and identity.

## Risks

- Resolving a conflict wholesale can drop independent fixes; inspect the base/ours/theirs
  changes and preserve both tests. Pay particular attention to run.ts and server.ts.
- Automatic upstream update/release destinations can overwrite the fork; audit all runtime
  repo/package URLs and preserve fork publication controls and disabled release workflows.
- Gates mutate dist; run them only in the isolated worktree, sequentially. Scrub inherited
  CEZ_* and NODE_ENV for gates; use temporary paths outside git for test scratch data.
- Do not touch sibling worktrees, unrelated corpus edits or the running cockpit.
- Manual service activation remains a separate authorized decision; do not activate it as
  a side effect of building or push code to the upstream remote.

## Verification

Required, executed on the integrated tree:

1. `npm ci` (or initial lockfile regeneration followed by clean install).
2. `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`,
   `npm run test:package`, in that order. No lint/format script exists in this repo.
3. `npm run test:e2e`; require `TEST_E2E_STATUS=passed`, not the skipped sentinel.
   Record screenshots and video for the runtime smoke in ignored per-run artifacts.
   Prepare each isolated browser fixture through local organization/team acceptance and explicit
   project registration before assertions. Keep production authorization unchanged, restore
   fixture state, and align navigation assertions with the retained fork UI.
   After a settings mutation, wait for the cockpit to render the saved capacity and enable
   dependent controls before entering the next value; separate API persistence alone does
   not prove the pending form has rendered its reply. Keep cold-reload persistence assertions.
   Submit the cross-project input-to-tasks composer and open its non-launch-project receipt
   in the new scoped filed-task detail page; require the matching todo summary and ID.
   Exercise automations in both the retained default-off shared environment and a private
   explicitly opted-in fixture: editor/templates, schedule manual run, calendars, next-run
   rail, and read-only GitHub poll preview/baseline. Keep provider execution in dry-run mode
   and clean up the fixture, automation records and detached descendants.
   The shared launcher must detach into its own process session on macOS and report the
   actual server PID, so ending the captured launcher shell cannot terminate the app.
4. Boot the built CLI using isolated CEZ_CONFIG_DIR/CEZ_HOME and a disposable project;
   assert readiness, health capabilities, project APIs, knowledge and sources, reports,
   account/cluster defaults, dashboard/tracker routes and static bundle delivery.
5. Browser-check onboarding, task creation/completion, thread/changes, dashboard,
   settings, knowledge and reports; assert no console errors or dead navigation.
   For both Changes views, verify the file tree stays within the main scrollport and
   scrolls independently in initial flow, after becoming sticky and after viewport resize;
   reach its last row without moving the main scroller. Measure sticky headers at their actual sticky offset, and
   verify bounded progressive thread pages in flat/virtual modes and cached/live arrival.
6. Scan for conflict markers, unresolved index entries, accidental gitlinks and restored
   vendor runtime dependencies. Confirm fork manifests/version alignment and safe updater
   destinations. Verify all new upstream files are present except documented vendor removals.
   Keep a disposition inventory for upstream modified/deleted paths and every conflict;
   preserve executable/symlink modes and honor deletions/renames.
7. Before delivery, confirm actual upstream tip is an ancestor of the merge result and
   `git merge-base HEAD upstream/main` advances to the synced upstream tip. Verify the
   pushed remote SHA equals the tested task commit. Never force-push main.
8. Run desktop `cargo check --locked --all-targets`, `cargo test --locked --lib` and its
   ignored Node/npm integration tests; build and attempt an isolated native smoke.
9. Assert dispatch under fork concurrency limits; explicit accounts through Continue and
   restart; monitoring/cancellation through multi-step postconditions; persistence of fork
   fields through run-store updates. Preserve both sides' coverage for each interaction.
   Execute `npm run test:e2e:cluster` against isolated hub/spoke processes to check retained
   authentication, enrollment, dispatch, replication and restart behavior.
10. Teardown the E2E server, browser and recordings on every exit and verify no process
    started by this run survives. If a remote advance changes the tree, repeat affected gates.

Detailed audit, lane reports and gate logs live in `.ai/qa/artifacts_upstream_sync/`.

Executed results: typecheck/build green; 852 passed Vitest files and 15,069 passed tests
(3 files / 9 conditional cases skipped); Node unit 47/47; package 47/47. Canonical
browser E2E passed all 43 files, 242 tests with 5 documented capability skips and
`TEST_E2E_STATUS=passed`; all 43 recordings are valid. Runtime/API and native smoke
passed, cluster 21/21, and desktop locked checks/build plus 14 normal and 3 opt-in
integration tests passed. Final post-harness web typecheck and 10 review checks passed.
Warm server reuse and exact-PID teardown passed; no owned test process remains.
The running operator cockpit retains its manual activation policy.
