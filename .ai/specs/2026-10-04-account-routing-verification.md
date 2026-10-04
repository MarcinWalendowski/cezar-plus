# Account routing verification

**Status:** Implemented · **Date:** 2026-10-04

## TLDR

Verify the updated fork through real local Claude/ChatGPT subscriptions, multiple models and two projects. Repair observed provider/account identity collisions and Continue preflight selection; deliver one follow-up fix commit after all gates and recorded runtime checks pass.

## Problem

The operator has Claude `pb` and Codex `pb`. `loadAgentAccounts` currently deduplicates globally by bare ID, discarding Codex `pb`; a subsequent write can persist that loss. Account reads, edits, deletes and UI caches also use bare IDs. Task routing already needs provider plus ID, while workflow preflight still infers a provider from the first bare-ID match. Continue preflight gates the old session account rather than an explicitly selected replacement and validates a pool as an ordinary account.

## Solution

Retain separate accounts by `(provider,id)`. Use provider-qualified opaque route IDs for stored accounts (`claude:pb`, `codex:pb`), preserving `default:<provider>`. Existing unqualified IDs remain accepted when unique; ambiguous unqualified requests refuse with 409 before any mutation. Keep persisted IDs and per-provider selection values unchanged. Continue preflight resolves the intended account before checking availability and handles supported pool routes consistently with task creation.

## Architecture

- Loader salvages each row and first-wins only duplicate pairs within the same provider. Preserve passthrough fields and atomic merge writes; no migration or operator file rewrite.
- Shared contract `agentAccountRouteId` yields provider-qualified stored account routes and unchanged discovered-default encoding. Account route resolution accepts the qualified form, or a unique legacy bare ID. Unknown IDs remain 404. Ambiguous IDs return 409 without file write, probe or OS open. Discovered accounts remain immutable.
- Account GET status/details, open, PATCH and DELETE resolve the same provider-scoped target. Mutators recheck the pair inside the atomic write. DELETE removes only that pair and clears only that provider's matching defaults and project selections. POST allocation checks IDs within the selected provider.
- UI query keys, usage/identity matching, React keys and edit/remove actions use qualified route identity. Composer selections continue to send the bare ID alongside provider. Preserve published usage response ID values (`default:provider` or bare stored ID); scope its internal identity cache and UI usage matching/React keys with agentAccountRouteId(row), using the existing provider and isDefault fields. No minor version bump is needed because existing response values and unique legacy routes remain supported. Preserve local-only disclosure/authentication boundaries.
- Workflow preflight treats a concrete account ID as scoped to its intended runner, exactly as selectProfile does; only pool routes may select another provider. Opposite authentication states for equal-ID Claude/Codex accounts must not affect the chosen runner.
- Continue validates explicit ordinary accounts first and exempts valid pool IDs using the existing account-usage capability rule. Availability requirements prefer the explicit account. When the provider changes without an explicit account, derive the new provider's project selection instead of the old provider's session account; no-override Continue preserves session/account affinity. Runner locks retain their existing precedence. For a requested pool, or a target provider's selected pool after a provider switch, the manager resolves a concrete provider/account before its session-affinity decision, applies model compatibility to the resolved provider, persists that concrete pair and resumes only when the provider/account pair owns the recorded session. No-override Continue stays on its recorded concrete account despite later project defaults. Pool candidates exclude workspace-disabled providers before ranking, including explicit and inherited pools, consistently with admission. A pool with no eligible member refuses rather than silently running the default. Pool selection is pure until the request passes validation; then advance the dispatch cursor once. Preserve existing lock/fallback precedence and context transfer.
- Reuse existing account/settings events and run events; this repairs identity rather than adding a new user interaction. Live proof includes emitted backend/profile/model/session events.

## Phases

1. Root authors spec; independent advisor reviews; capture failing API/storage evidence against delivered a8c58088.
2. Disjoint implementation/verification lanes: contract/storage loader; server account API/Continue integration; cockpit caches/actions; Continue requirements and manager pool execution; live HTTP/project/subscription harness. No concurrent writers to the same file; root coordinates builds and integration.
3. Run focused regressions, sequential source gates, canonical recorded browser E2E, real subscription/project matrix, inspect screenshots, and verify cleanup.
4. Investigate the observed GPT-6 Luna low-effort mixed-step file-tool refusals at the owner's request. Compare direct native exec and the built app-server adapter with fixed account/model/cwd, short versus full first/second-step prompts, summary auto versus none, and low versus medium effort. Require actual local file tool calls and native model/effort context. Retain failed probes; do not automatically override user-selected model or effort.
5. Commit one follow-up feature fix and push exact verified commit to origin/main only. Refresh the existing corpus task/note/changelog with honest live results and reindex. Do not activate or alter the operator checkout; read-only probes found no active operator cockpit process.

## Data Models

Unchanged stored account shape, IDs, defaults/selections and run records. Account identity is the existing `(provider,id)` pair. Native provider history/token refresh from actual subscription probes is allowed; login/account defaults and operator Cezar registry remain unchanged.

## API Contracts

Account route `:id` accepts `provider:storedId`, legacy unique `storedId`, and `default:provider` for reads. Responses retain their existing shapes and existing usage ID values. Document additive qualified management routes and ambiguous-route refusals in the public changelog/compatibility record. No qualified management ID is persisted or sent as a composer selection. Ambiguous legacy operations return `{error}` with 409; unknown targets return 404. Start/Continue bodies remain `{runner,model,agentProfile}` with provider-scoped bare profile ID or a supported pool. Explicit unknown Continue account returns 400; a pool with account usage disabled returns 409. Rejected operations must not mutate run/account state.

## Risks

A partial scoping fix could retain rows while still merging caches or deleting the other provider. Cover reads and writes plus UI identity/usage keys. Default account encoding and unique legacy routes are released contracts; keep them. Provider availability/model catalogs are not entitlement proof; require actual model execution. Scrub ambient API-key/cloud overrides so live subscription claims cannot be accidental API billing. Builds mutate dist and must run sequentially before runtime/browser work. Stop only exact owned processes; preserve operator service and unrelated edits.

## Verification

- Storage regressions: Claude/Codex equal IDs survive load and merge-write; same-provider duplicates retain first-wins; selections resolve intended provider.
- API regressions: scoped status/details/open/PATCH/DELETE target the intended provider; ambiguous bare requests 409 with unchanged files; unique bare/default reads preserved; delete clears only target references; old account and other provider remain untouched.
- UI regressions: equal-ID rows display distinct provider status/identity/usage and edit/remove actions address the right account; cache/React keys do not collide.
- Continue regressions: disconnected old account to connected explicit account accepted, reverse refused; runner change without account uses target project selection; unknown account/pool capability refusals do not mutate state; lock precedence and native affinity retained; concrete pool choice executes, persists across restart and uses correct session affinity, with no cursor/run mutation on rejected model requests. A healthy disabled provider ranked ahead of a healthy enabled provider must never execute or receive a dispatch cursor.
- Fresh sanitized Node24 gates: typecheck, full npm test, Node unit, build, package install tests; existing two-worker cap, no lint script configured. Run on final committed tree as well as changed tree where HEAD-sensitive checks exist.
- Full canonical browser suite requires TEST_E2E_STATUS=passed with valid recordings, source fingerprint unchanged, actual screenshot inspection and cleanup.
- Actual built-server matrix: two disposable committed projects with unique marker files; configured accounts freshly checked via native CLI, all authenticated accounts perform bounded live marker turns; at least two discovered models per provider. No CEZ_DRY_RUN/API-key substitution. Verify returned marker, resolved model/provider/account/session and on-disk records, wrong-project 404 and separate worktrees.
- Continue same account/model, model switch, account switch and provider switch; selected account precedence against different project default; provider pools and wildcard pool; isolated server restart persistence. Mark unavailable/limited profiles honestly, without silently substituting another login/model.
- Compare the Luna low-effort app-server refusals with direct native controls; record actual tool execution and prompt/summary/effort/account differences before attributing cause.
- Record real live cockpit project/task/settings views, inspect captures, stop every owned server/browser/broker/provider process, and prove the operator registry/checkout remains unchanged.

## Executed results

Sanitized Node 24 gates passed: typecheck, build, 15,119 source tests with 9 conditional skips, 47 Node tests and 47 package tests. No lint script or configuration is present. The full canonical browser run passed all 43 files and 242 tests with 5 capability skips; all 43 videos are valid and tracked fingerprints stayed unchanged. Two-node cluster verification passed 21 assertions.

Actual built-server verification exercised six usable local subscriptions, five models and two isolated committed projects, including provider/account switching, inherited and explicit selection, native resume, pools, disabled providers, restart persistence and eight recorded cockpit checks. One named Claude profile is logged out and another receives a native weekly-limit refusal; no substitution is counted as success.

Three earlier low-effort Luna probes failed to use a file tool. Direct CLI and adapter controls plus two fresh actual Cezar chains subsequently passed at unchanged low/auto settings. No deterministic routing, tool-provisioning, effort or summary defect was identified; the intermittent failures' cause remains unproven. No setting override was added. Failed attempts are retained alongside successful reruns.

Final exact-process cleanup, stopped mock descriptor, removed disposable fixtures and unchanged operator checkout/registry/config hashes are recorded in the ignored artifact directory. Empty 1Password IPC directory remainders were removed after confirming there were no files or owned processes. The operator checkout is not activated. See `.ai/runs/2026-10-04-account-routing-verification.md` for account/model results and evidence paths.
