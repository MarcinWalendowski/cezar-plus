# Brief: central hub record

## Problem

The historical task describes a programme to make cezar the workspace hub for durable knowledge, external sources, notes, and cross-project views. Its implementation-status statements are stale: Phase 1 and later extensions are on `origin/main`, not uncommitted work on an active feature branch. The next change must identify a remaining gap and extend the existing vertical slice, not create a plugin system, a second knowledge store, or revive the old branch.

## Record already decided

- The programme authority is [the central-hub PLAN](../../runs/2026-08-06-cezar-central-hub/PLAN.md:33). It rejects a plugin-first approach and defines a vertical slice across contract, service, web, and central wiring. The original task record agrees that cezar had no plugin or extension registry: KB `notion-76ae9455721e`, `knowledge/sections/274-cezar-as-the-central-hub-2026-08-06.md:20-24`.
- F1 is the one knowledge system. Disk content is mounted read-only, while remote pages are mirrored to disk and registered as an F1 root, not imported into a separate store ([PLAN D3](../../runs/2026-08-06-cezar-central-hub/PLAN.md:35); [F1](../2026-08-06-knowledge-base-mounts-search.md:16)). F1 owns both file watching and post-sync `notifyChanged`; mirrored conflicts and deleted copies are excluded; adoption moves a document into the writable knowledge root ([PLAN D15-D18, D24-D25](../../runs/2026-08-06-cezar-central-hub/PLAN.md:55)).
- A GitHub forge cannot represent Notion. The required seam is a generic, registry-keyed `SourceProvider`, not a literal provider union: KB `notion-76ae9455721e`, `knowledge/sections/274-cezar-as-the-central-hub-2026-08-06.md:22-30`; [F2](../2026-08-06-external-source-connectors-notion.md:1).
- Central, cross-project reads must not boot project contexts, because that can recover and resume agent runs. Run records remain project-less. Cross-project indexes parse project-local data or open standalone read stores ([F3](../2026-08-06-workspace-notes-cross-project.md:280); KB `notion-76ae9455721e`).
- Feature behavior is protected: exact opt-in flags, schema-valid empty 200 responses when off, 409 for disabled mutators, no runtime dependencies, no clock-derived GET fields ([PLAN D4-D8, D19](../../runs/2026-08-06-cezar-central-hub/PLAN.md:36)). F1 also requires identifier-aware search and byte-identical prompt behavior with KB disabled ([F1](../2026-08-06-knowledge-base-mounts-search.md:16)).
- The corpus is now the record and Notion is read-only. An operator-level mount in `~/.cezar/config.json` makes the corpus visible to every registered project, correcting the earlier one-project mount: KB `notion-711b57ca383e`, `domains/cezar.md:61-68`; KB `notion-30a0d979de2b`.

## Current code and landed state

- Commit `65eef6d2` landed Phase 1 in 174 files: knowledge, sources, notes, notifications, contracts, APIs, and cockpit UI. It is an ancestor of both `origin/main` and `origin/feat/knowledge-base-central-hub`; the old feature branch has no unique commits. Do not revive it.
- Commit `94b62452` added workspace-level Git and knowledge views. Later commits `75f6abaa`, `80c7ee36`, `63de653c`, and `11467f44` respectively extend workspace knowledge, grounding/operator mounts, and the replacement note-to-spec flow.
- `KnowledgeStore` is the landed F1 store, including watcher plus `notifyChanged` triggers and the source sink boundary ([store.ts](../../../packages/cezar/src/knowledge/store.ts:42)). The project API factory is [knowledge-routes.ts](../../../packages/cezar/src/server/knowledge-routes.ts:159).
- The external-source seam exists: [provider-types.ts](../../../packages/cezar/src/sources/provider-types.ts:15), [registry.ts](../../../packages/cezar/src/sources/registry.ts:1), a Notion provider, and also a `cezar-hub` provider. Project source routes are [sources-routes.ts](../../../packages/cezar/src/server/sources-routes.ts:199).
- Workspace knowledge is an aggregate over the same stores, not another KB. Its no-context-construction invariant is [knowledge-index.ts](../../../packages/cezar/src/workspace/knowledge-index.ts:7), with routes at [workspace-knowledge-routes.ts](../../../packages/cezar/src/server/workspace-knowledge-routes.ts:122) and contract at [workspace-knowledge.ts](../../../packages/contract/src/workspace-knowledge.ts:5).
- Registry-backed projects are managed by [projects.ts](../../../packages/cezar/src/workspace/projects.ts:234). `RunRecord` has no persisted project key, while workspace summaries add attribution from each registered project's records: [runs.ts](../../../packages/contract/src/runs.ts:377), [run-index.ts](../../../packages/cezar/src/workspace/run-index.ts:245).
- Server wiring constructs project knowledge/source stores and workspace aggregates, including notes, at [server.ts](../../../packages/cezar/src/server/server.ts:7447) and [server.ts](../../../packages/cezar/src/server/server.ts:7557).

## Corrections and constraints

- The task KB entry `notion-003426d0cf3f` is stale where it says Phase 1 is uncommitted and ungated. Its source is `notion-export/tasks/3b4b9863-cezar-as-the-central-hub-knowledge-base-external-sources-not.md:29-51`; `65eef6d2` contradicts it.
- The PLAN heading still says proposed/not started, but its decisions remain the authority. Its later cutover amendment records that the planned dual-write did not land and remains superseded ([PLAN](../../runs/2026-08-06-cezar-central-hub/PLAN.md:89)).
- F3 removed the original capture inbox, while retaining cross-project views ([F3](../2026-08-06-workspace-notes-cross-project.md:1)). A distinct note-to-spec pipeline was later implemented by `11467f44`. A spec must not treat these as the same feature.
- Notion cutover does not imply indexing is automatically current. KB `notion-7eb98db532d2` records a production miss where nine corpus writes remained absent until `CEZ_KB=1 cez kb reindex`; the root cause was no live KnowledgeStore/watcher for that corpus project.
- This is a released npm package. Its backward-compatibility policy applies, unlike the workspace default: KB `notion-76ae9455721e`, `knowledge/sections/274-cezar-as-the-central-hub-2026-08-06.md:26-30`.

## Open questions for the next spec

1. What concrete, unmet central-hub capability remains after the landed implementation and corpus cutover? The task names a programme, not an isolated defect.
2. If the goal is fresh corpus visibility, should the solution ensure a live store/watcher, schedule a bounded reindex, or expose an explicit operator refresh? It must preserve the existing source-to-KB trigger contract and zero-config behavior.
3. Does the desired work belong to generic cezar functionality or the fork-private Phase 3 ticket and multi-player work? Phase 3 remains unstarted ([PLAN](../../runs/2026-08-06-cezar-central-hub/PLAN.md:103)).
4. Which historical QA gaps are in scope? Existing records retain several QA Needed states, but they do not authorize rerunning or changing already-landed features without a specific failure or acceptance target.

## Verification implications

Any new spec must retain the original negative controls: identifier pinning disabled must fail the `SPEC-282` search case; a two-page Notion fixture must return the page-two match; and flag-off health plus agent prompt parity must use an injected clock. It must separately test the selected remaining gap, including a runtime E2E for a user-facing change. No build, test, or runtime command was run for this record-gathering step.
