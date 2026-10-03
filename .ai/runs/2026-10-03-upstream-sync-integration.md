# Cezar Plus upstream integration — 2026-10-03

Status: implemented and verified on 2026-10-04. Source-only delivery to origin/main;
operator service activation remains manual. Spec: `.ai/specs/2026-10-03-upstream-sync-fork-integration.md`.

## Provenance and history

Origin is `git@github.com:MarcinWalendowski/cezar-plus.git`; upstream is
`https://github.com/open-mercato/cezar.git`. Delivery goes only to origin/main.
The starting fork is `dc655ca14a52cfb353ca3b811ac0375f2303e3bc`.
The upstream target is `1b13522dd3642a4ea8331629b3680838164d2a2e` (0.14.0).

The histories had no merge-base after historical rewriting. Upstream
`1912f2f2aefe2596a72b6a21eef053682f64dda8` and fork
`0c966fc1c00840e55a8f178423e84829037ca0c2` have exactly the same tree,
`01a62368a97858f57103891fb4e824ab2e4071f1`. That verified 0.10.0 snapshot
was the three-way base, covering 136 subsequent upstream commits and 589 fork commits.
Only package names were normalized in temporary merge inputs; those objects are not
parents of the delivered commit. The actual upstream target is its second parent.

## Changes made in our fork

The fork adds a knowledge corpus with search, source connectors/conflicts, notes and
report triage; organization/team identity and authorization; account pools, usage and
fallback; workspace tasks, cluster replication and security; resource limits; configurable
workflow models/effort/classification; continuation, postconditions and manual activation.
It has its own package identity, brand and publishing destinations. These remain present.

## Upstream changes incorporated

The integration brings in dashboard/costs/feed, task dispatch and child budgets,
Jira/Linear tracker connections and triggers, redesigned automations, persistent drafts,
PDF/text attachments, host telemetry, provider authentication refresh, runner adapters,
monitoring, cancellation and compaction fixes, self-update and the native desktop shell.
Contracts, service, client, UI, tests, reference docs and upstream history are integrated.
All core workspace packages and CLI aliases advance together to 0.14.0; desktop retains
its separate 0.1.3 version.

### Migrated feature inventory

This inventory was checked against all 136 commits and upstream release entries
0.10.1–0.14.0. Existing fork capabilities listed above are preserved, not counted as new.

| Feature | New capability |
| --- | --- |
| Cursor runner | Cursor Agent CLI, model discovery, settings and protocol events. |
| Copilot runner | GitHub Copilot ACP launch, follow-up, cancellation and resume. |
| Junie runner | JetBrains Junie ACP with account/model configuration and recovery. |
| Claude model discovery | Model picker reads the installed Claude CLI's available models. |
| Task dispatch | Implementation/review child tasks, carved budgets, child reports and parent-branch integration. |
| Nested subtasks | Collapsible task trees in project/global lists and sidebar. |
| Task pinning | A per-project pinned group above other active tasks. |
| Continue accounts | Choose another account when continuing a task. |
| Engine switching | Change runner/model/account with conversation context carried forward. |
| Persistent thread drafts | Unsent messages and attachments survive navigation and restart. |
| Conversation timing | Turn timestamps, durations, date separators and working/last-activity clock. |
| Claude streaming | Show assistant text while it is generated. |
| Document attachments | PDF, TXT and Markdown alongside images. |
| Attachment library | Named project attachments reusable by later tasks. |
| Project order | Drag project groups and persist their order across browsers. |
| Project switching | Header project links and composer carryover. |
| Project discovery | Discover an unregistered launch folder; explicit registration retains its boot ID and store. |
| Branch tools | Search/filter base branches and copy a task branch from its header. |
| Pull-request associations | Remember every task-related PR, preserving repository and reference provenance. |
| PR merge conflicts | Conflict status on PR chips and a one-click action asking the task to resolve them. |
| Scheduled automations | Daily, weekdays, weekday and hourly schedules, timezone/DST support, calendars, templates and creation from prompt. |
| Automation triggers | PR-review and tracker triggers with account/skill pickers. |
| Jira and Linear | Project credentials, association, ticket browsing/search/filtering, task handoff and refresh/recovery. |
| Workspace dashboard | Attention, live work, outcomes, project comparison, schedules, costs, trends and PDF/CSV export. |
| Dashboard insights | Delivery counts, failure reasons, cost per completed task and automation outcomes. |
| Host telemetry | Container/cgroup-aware CPU/RAM capacity, machine card and sidebar warning meters. |
| Resource controls | Integer steppers and inherited project concurrency limits. |
| Waiting timeout | Configure idle waiting-session shutdown from 0 to 1,440 minutes; zero disables it. |
| GitHub ordering | Persist newest/oldest sort order across reloads. |
| Managed installation and self-update | CLI install/update/versions/use, managed directories, stable/nightly selection and in-cockpit updates under fork authorization. |
| Development updates | Local checkout links, PR previews and stale-checkout build before switching. |
| Native desktop | Tauri shell, local sidecar, native controls and distribution tooling; fork icons and manual activation retained. |
| Additional CLI alias | `cezar-run` launcher adapted to the fork's scoped package names. |

The imported Gemini/custom-provider runner-seam, adaptive admission governor and
dispatch-admission scheduler documents are proposals, not implemented features.
The Pi runner was already in the fork. Provider executables are optional; runtime
smoke tasks use the real orchestration path with dry-run provider processes.

Reliability fixes cover multi-process persistence, terminal cancellation, monitoring
and auto-continue, task titles/accounts/PR references, Codex compaction, OpenCode long
turns, Pi message identities, idle timeouts, automation cursors/locks/leases,
worktree base fetching and conflict actions, local transcript-link blocking, bidi
filename stripping, provider-auth recheck, installer restart identity, mobile layouts
and rendering. CodeQL, additional tests and reference/Chinese documentation are imported.

Combined-boundary fixes include attachment hydration, account selection on continuation,
async continuation routes, fork task-author provenance, dispatch child recovery reports,
inactivity parking through pending verification, and cancellation timer cleanup. Explicit
launch-folder registration retains its boot ID and original store, with ordinary org guards.
Cross-project filed-task receipts now open the new scoped standalone detail page instead
of the removed global dialog, independently encoding the project and todo path segments.
Exact links and reserved-character escaping pass regression coverage; browser verification
requires a receipt belonging to a different project from the launch folder.

## Deliberate adaptations

- Automations remain exact `CEZ_AUTOMATIONS=1` opt-in; dispatch is default-on as upstream.
- Workspace routing tasks reject project-local dispatch; project tasks retain dispatch.
- Vendor skills, update banners and star promotion remain removed. Optional star-count
  reads are inert by default and point to the fork if an operator supplies a reader.
- Fork favicon remains `cezar.svg`; imported `icon.svg` is also shipped. Native icons and
  the desktop bootstrap icon are generated from the existing fork purple C-and-dot SVG. Settings retain
  the fork's sources/knowledge/account sections and editable team skill catalogs.
- Nightly/public publishing remains disabled. CI verification is active. Desktop uses
  `com.lokilabs.cezarplus`, fork packages and links; its updater is disabled until fork
  signing/publication is configured, with no trusted vendor key or endpoint.
- Hosted self-update writes require an authenticated org owner/admin. Building and pushing
  do not activate the running service; the fork's manual activation policy remains current.

The per-path upstream inventory covers all 1,027 changed paths: 680 match normalized
upstream exactly, 337 combine/adapt changes, and 10 retain a documented fork choice. Its only intentionally
absent incoming additions are the four vendor star-promotion component/library files and
tests. Vendor skills-banner/skills-update files and the deleted fork nightly workflow remain
absent. The old automation route module survives only as a re-export for fork imports.
Detailed inventory, original conflict stages, lane reports, logs, screenshots and recording
are retained under ignored `.ai/qa/artifacts_upstream_sync/`.

## Verification

Verification uses macOS, Node 24.20.0 and Rust 1.99.0. Full Vitest concurrency is capped
with the existing `CEZ_VITEST_MAX_WORKERS=2` option after measuring load over 300 on
this 16-core shared machine; no test timeout or assertion was weakened.
- `npm ci`, `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`
  and `npm run test:package`: passed. Final full Vitest: 852 passed files, 3 skipped;
  15,069 passed tests, 9 skipped. Node unit: 47/47. Package: 47/47.
- Browser/runtime smoke: 13 checkpoints plus four settled captures passed with zero
  console/page errors; onboarding, creation, completion, changes, dashboard/settings,
  knowledge, reports and mobile. Screenshots and WebM recordings retained.
- Runtime API smoke: 34 successful requests with contract validation, including
  knowledge indexing/search, sources, dashboard modules, reports dismiss/reopen,
  completed run state, text attachment/draft round-trip, pinning, account/default
  surfaces, notes, self-update and inert star-count contract.
- Cluster: real hub/spoke E2E passed 21/21 assertions after bounded persistence/readiness
  and fixture activation fixes. Tests include actual spoke restart, a write while offline,
  fresh pairing/capacity/drift, worker refusal with no run, real remote/local dispatch,
  author provenance, exact claim loopback and no duplicate self-start. No runtime change
  was needed; every tracked process exited and every fixture was removed.
- Desktop: locked check/build passed, 14 library tests plus all 3 explicitly ignored
  real Node/npm integration tests passed. Native ready-cockpit smoke loaded the built
  0.14.0 fork UI, verified native maximize/titlebar drag, captured screenshot/video,
  and confirmed no vendor updater surface. Seed/app/sidecar processes all stopped.
- Portable E2E launcher: detached Node child survives the captured caller on macOS,
  reports its actual PID, reuses the same warm server and tears down that exact process.
  Both launcher conformance cases and the real built-CLI scratch smoke passed.

The sequential gates were repeated successfully after the measured Changes-pane repair:
the main shell publishes its actual height without React rerenders, and both file trees
use that height to remain inside the scrollport. The 138 focused height/pane tests also passed.
The tall task header's initial flow subsequently required a shared callback-ref measurement:
cap against both current available room and the sticky ceiling, with RAF-coalesced direct
style updates and full observer/listener cleanup. Its 42 focused tests and independent
source review passed; the final sequential gates and recorded geometry checks cover this tree.
All browser E2E sessions now record WebM by default; fixture teardown captures exact
descendants and rechecks their start times before stopping detached provider processes.
Reparented run brokers are additionally identified by this worktree's exact CLI and a
spool path under the attested disposable fixture root; a real detached parent/child
cleanup proof passed. An independent final review found no blockers in this cleanup,
receipt routing or fork updater/publication protections.

The final canonical `npm run test:e2e` passed all 43 files: 242 tests passed, 5
intentional capability cases skipped, and `TEST_E2E_STATUS=passed`. All 43 new WebM
recordings are nonempty and ffprobe-valid (13,866,388 bytes); source fingerprints
were identical before/after across 2,848 files. Final web typecheck and all 10 design
review checks passed. The only change after the last full source gates was the
monitoring E2E synchronization correction below, exercised twice in isolation and
in the final complete browser run; production source remained unchanged.

Browser skips: three enabled-inbox cases and its live badge case require the fork's
disabled-by-default follow-up inbox; the fifth requires constrained single-project
mode while this server runs the actual multi-project workspace. The disabled inbox
explainer and grouped-project flows executed. Automations execute all four default-off
and private opted-in cases, and the composer receipt executes all three cases.
Source-suite skips: three opt-in real Copilot cases, Claude's live resume-model case,
two live Claude/Codex missing-session contracts, optional live S3 integration, Linux
`/dev/shm` discovery, and GNU-sed-only nginx rewriting. Runtime provider execution is
dry-run; real paid vendor calls and external S3 were not part of the verification.

Both Changes trees reach their final row independently in natural, sticky and resized
states. Task tree: 122 rows; repository tree: 120. Pane bottoms are 884 within 900 px
and 624 within 640 px after resize, preserving a 16 px gutter and unchanged main scroll.
The non-launch-project receipt opens the correct fixture-b standalone task detail;
monitoring capacity and interval persist through a cold reload. Captures were inspected.

Private fixture cleanup attests zero owned HTTP servers, detached brokers, browser
processes or provider PID files. The shared environment reused the same warm PID 1163,
then its exact-PID teardown passed with no survivors; descriptor is stopped. Original
operator checkout remains clean at `ef59fa72`, and its running service was not activated.
Earlier failed browser runs and cluster fixture races remain in the ignored evidence
rather than being reported as passes.
The penultimate browser run passed 42/43 files; its one monitoring-settings failure
was reproduced and measured: the API had persisted capacity before React rendered its
pending state, so an enabled-only wait raced and the browser filled a disabled interval
control. The form/API correctly persisted both values in the diagnostic sequence.
The test now waits for rendered capacity and enabled controls, retaining exact API values
and cold-reload assertions; no production save logic or timeout was changed.
The whitespace check excludes only the imported historical patch artifact
`assets/automations-redesign/patch/0001-automations-from-prompt.patch`; its context and
mail-patch signature contain significant trailing spaces. It remains byte-identical to the
normalized incoming tree; its only differences from original upstream are the two package-name
substitutions applied consistently to the merge inputs.
