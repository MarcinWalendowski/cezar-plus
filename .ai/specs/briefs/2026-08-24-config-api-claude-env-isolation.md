# Config API Claude env isolation brief

## Problem

`npm test` is not hermetic on a host that exports `CLAUDE_CONFIG_DIR`. The config API model-defaults fixture changes `HOME` to a temporary directory and writes `$HOME/.claude/settings.json`, but leaves the process-level Claude home override intact. The real resolver therefore reads `$CLAUDE_CONFIG_DIR/settings.json`, not the fixture, and the test reports no `claude` default model.

The measured production condition is explicit: task `f2280db6` recorded one failure and 11,775 passes from `npm test`, while `env -u CLAUDE_CONFIG_DIR npm test` passed all 11,776 tests. This is a test-gate reliability defect, not a Claude configuration or model-defaults product defect.

## Record already decided

- `CLAUDE_CONFIG_DIR` deliberately relocates Claude's default home. The agent-account autodetection decision says the process-level variable changes the discovered default and accepts any absolute directory. The test must not weaken that precedence. [KB `specs-362123d36be2`; `.ai/specs/2026-08-14-claude-subscription-autodetect.md:29-42`]
- The current prompt-drafts record already diagnosed this exact fixture: it records the missing `CLAUDE_CONFIG_DIR` save/delete/restore and classifies the result as an environment trap rather than a product regression. [`.ai/specs/2026-08-22-per-task-prompt-drafts-qa-and-closeout.md:277-289`]
- The gate-environment policy requires a validation gate to scrub ambient variables it does not mean to test, while a suite that does test a variable owns its setup and restoration locally. [KB `specs-cb279cda3c66`; `.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md:419-437,590-605`; commit `1c225e7e`]
- The nearest implementation precedent is the discovered-account API suite, which saves, deletes, and restores Claude's override while it uses a fake home. The change that installed the broader Vitest guard is recorded as fixture isolation, not a resolver change. [KB `notion-82e42a379b69`; `.ai/specs/2026-08-24-isolate-discovered-account-tests.md`; `packages/cezar/src/server/agent-profiles-discovered-api.test.ts:25-69`; commit `2888f117`]
- The Cezar domain record describes a deployed coding-agent cockpit whose gates must be trustworthy. It does not contain a contrary decision about model-resolution precedence or test fixture isolation. [`/var/lib/cezar/loki-labs/notion-export/domains/cezar.md`, "What it is" and "Current state"]

## Code involved now

- `packages/cezar/src/paths.ts:256-263` resolves `home.claude` from a nonblank `CLAUDE_CONFIG_DIR` before falling back to `HOME/.claude`.
- `packages/cezar/src/agent-config/catalog.ts:85-99` defines `claude.user.settings` at `join(home.claude, 'settings.json')`; `packages/cezar/src/agent-config/catalog.ts:152-160` uses the same home for Claude user memory.
- `packages/cezar/src/server/server.ts:6726-6735` obtains config defaults through `readAgentModelDefaults(repoRoot)` without an explicit environment, so it correctly sees the process environment. `packages/cezar/src/agent-config/models.ts:23-43` defaults its environment argument to `process.env`, and `packages/cezar/src/agent-config/model-settings/claude.ts:4-10` delegates to native settings resolution.
- `packages/cezar/src/server/config-api.test.ts:24-60` currently owns and restores `HOME`, `CEZ_HOME`, `CODEX_HOME`, `XDG_CONFIG_HOME`, and `CEZ_AGENT_MODELS_LOCKED`, but not `CLAUDE_CONFIG_DIR`. Its native-model fixture writes the fake Claude settings at `:99-105` and expects `claude: 'sonnet'` at `:107-111`.
- `d6385531` introduced the native-model fixture and its incomplete environment guard. [`d6385531`; `packages/cezar/src/server/config-api.test.ts:24-60,99-113`]

## Scope of the fixture sweep

The only other confirmed process-environment fake-home `.claude` fixture is `packages/cezar/src/server/agent-profiles-discovered-api.test.ts`; it already performs the required save, delete, and restore. No change is needed there.

Other examined `.claude` fixtures are immune because they pass an explicit environment rather than reading `process.env`: `packages/cezar/src/agent-config/models.test.ts:32-65`, `packages/cezar/src/agent-config/files.test.ts:9-18,95-104`, `packages/cezar/src/agent-config/catalog.test.ts:4-9`, and `packages/cezar/src/workspace/agent-account-identity.test.ts:169-199`. `workspace/agent-accounts-auto.test.ts:188-199` likewise supplies its discovery environment. Repo-local `.claude` fixtures are not fake home fixtures. No additional unguarded consumer was confirmed by the read-only sweep.

## Constraints and prior-decision conflicts

Changing `agentHomePaths`, the catalog, or model resolution to prefer fake `HOME` would contradict the agent-account decision and break a valid production configuration. The narrow fix is test-local ownership of the ambient variable: capture its original value, delete it in `beforeEach`, and restore or delete it in `afterEach`, matching the existing fixture precedent.

The implementation must preserve tests that intentionally pass `CLAUDE_CONFIG_DIR` in an explicit environment, including the override assertions in `packages/cezar/src/paths.test.ts:112-160`.

## Related work and gaps

`cezar todo list` reported no todos. The history search found no in-flight duplicate for this config API fixture. The related `cez/f2280db6` branch is an autosave/run-finalize branch, not an implementation branch. No test or build was run in this record-gathering step.

## Open questions for the spec

1. Does this qualify as a narrow enough correction to implement directly in the existing test file, or does the workflow require a new implementation spec despite the one-file code change? The governing workflow normally requires a spec for a new concept or multiple files; the intended fix introduces neither.
2. The implementation verification must run `npm test` with `CLAUDE_CONFIG_DIR` exported and confirm the complete gate is green. It should also preserve the focused assertion that the fake HOME contributes `claude: 'sonnet'`.
3. Should the implementation add a focused regression test that explicitly sets an external `CLAUDE_CONFIG_DIR` before constructing the fake HOME, or is the production-environment full-gate invocation sufficient? The existing fixture currently exercises the behavior only when the ambient variable happens to be set.

## Most constraining facts

1. `CLAUDE_CONFIG_DIR` is intentional, higher-priority product behavior and must not change.
2. `config-api.test.ts` owns four comparable home variables but omits Claude's, so its fake `$HOME/.claude` fixture is non-hermetic.
3. The discovered-account API suite already provides the exact local save, delete, restore precedent.
4. No other unguarded fake-home `.claude` consumer was confirmed; most candidates pass an explicit environment and are already isolated.
