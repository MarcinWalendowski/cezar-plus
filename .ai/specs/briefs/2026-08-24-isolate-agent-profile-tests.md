# Brief: isolate agent profile tests

## Problem

`packages/cezar/src/server/agent-profiles-discovered-api.test.ts` is intended to be a
fixture-only API suite. It replaces `HOME` with a temporary directory
(`:38-52`), yet does not save, clear or restore `CODEX_HOME` (`:26-32`, `:57-69`).
The inherited host value on this machine is `/var/lib/cezar/.codex-secondary`.

That is observable as two focused-test failures: the exact discovered-account assertion
at `:109` receives a host Codex row, and the realpath assertion at `:157` receives the
same extra row. The recorded reproductions show both the task worktree and the parent
checkout fail identically, with 2 failed and 3 passed
(`/tmp/cezar-b3b5719c-test.log`, `/tmp/cezar-b3b5719c-control-parent-agent-profiles.log`).

This is not evidence that production discovery is wrong. `agentHomePaths()` deliberately
gives `CODEX_HOME` priority over `HOME/.codex`
(`packages/cezar/src/paths.ts:256-264`), and the discovered-profiles route calls the
real discovery function without a test-specific environment
(`packages/cezar/src/server/server.ts:2928-2952`). Therefore a host override becomes the
Codex default even while the suite's fake `HOME` contains only its Claude fixtures.

## What the record already decided

- Codex profiles are a supported relocation boundary: `CODEX_HOME` moves the whole Codex
  home, including `auth.json` and identity (`packages/cezar/src/core/agent-profiles.ts:23-45`; KB
  `specs-4d06fee89bcd`, current).
- Discovery must begin with the resolved provider default and then examine marker-recognized
  siblings, rather than merely assuming `HOME/.<provider>`
  (`.ai/specs/2026-08-14-claude-subscription-autodetect.md:29-42`, KB
  `specs-362123d36be2`, current).
- D4 deliberately widened discovery from Claude to every profile-capable provider, scanning both
  `~/.claude*` and `~/.codex*`; Codex markers are `auth.json` and `config.toml`
  (`.ai/specs/2026-08-24-second-codex-account-balancing.md:212-217`). This was implemented by
  `d01fc102` (`feat: a second codex account, detected by itself, and a pool that can balance it`).
  Do not narrow the production discovery set to restore this test.
- The prior Claude-only credential concern is superseded for this purpose. The current decision
  reads only identity claims and requires a credential-non-leak test
  (`.ai/specs/2026-08-24-second-codex-account-balancing.md:134-151,326-329`; KB
  `specs-d77609665477`, current).
- Test-local environment isolation is established precedent. The KB isolation spec chose
  per-suite save, clear and restore as a second line behind the global scrub, not a production
  redesign (`.ai/specs/2026-08-22-agent-profile-wiring-cez-kb-test-isolation.md:200-238`,
  implemented by `878708f5`).

## Code actually involved

1. `packages/cezar/src/server/agent-profiles-discovered-api.test.ts:26-70` owns this suite's
   fixture process environment. It currently isolates `CEZ_HOME`, `HOME`, `CEZ_REMOTE`,
   `CEZ_DRY_RUN` and `CLAUDE_CONFIG_DIR`, but not `CODEX_HOME`.
2. `packages/cezar/src/paths.ts:248-264` resolves the Codex default as
   `CODEX_HOME` when non-empty, otherwise `HOME/.codex`.
3. `packages/cezar/src/workspace/agent-account-identity.ts:164-224` obtains those resolved
   defaults and then performs provider sibling discovery.
4. `packages/cezar/src/server/server.ts:2928-2952` maps every discovered result into the API
   response, including `added` calculated against stored profiles.
5. `packages/cezar/src/workspace/agent-account-identity.test.ts:318-352` already pins the
   intended Codex behavior, including `CODEX_HOME` precedence and secondary Codex homes. That
   behavior must remain covered and must not be weakened to fix the API fixture.
6. `packages/contract/src/agent-profiles.ts:160-186` now admits Codex discovered-account rows.

The stale test header still calls this endpoint "the Claude logins" at
`packages/cezar/src/server/agent-profiles-discovered-api.test.ts:17-23`, although the current
contract and product behavior are provider-wide.

## Related work and duplicates

`cezar todo list` reported `no todos filed` during this investigation. No related open todo or
existing brief for task `b3b5719c` was found.

Three active worktrees, `cez/9bf5030d`, `cez/e6592588` and `cez/eeceb869`, contain the same
uncommitted one-file change against main: save, clear and restore `CODEX_HOME` in this suite.
They share commit `8219c6f0` as their base, not an independently tracked implementation. Reconcile
with those branches rather than creating a parallel fix.

## Constraints for the next spec

- Keep the production precedence rule and cross-provider discovery unchanged.
- Make the API suite independent of all real host Codex profile directories by owning its
  `CODEX_HOME` lifecycle alongside `HOME`.
- Retain focused coverage for the endpoint's intended Codex response shape, rather than leaving
  only Claude fixtures that can silently stop exercising the widened contract.
- Verification must include the focused suite with a host `CODEX_HOME` pointing outside its
  temporary fixture root, plus the root `npm test` gate. No runtime UI E2E is indicated for a
  test-fixture-only change.

## Open questions for the spec

1. Should this suite clear `CODEX_HOME` so discovery falls back to its fake `HOME/.codex`, or set
   it explicitly inside the fixture root and add a Codex fixture? Either is isolated; the latter
   exercises the widened route contract in this API suite.
2. Should the implementation audit other test files that replace `HOME` but call code honoring
   provider-specific home overrides? The current evidence identifies this suite only; no broader
   defect has been measured.
3. Should the stale Claude-only test description be corrected in the same change? It describes
   the current endpoint inaccurately but does not affect runtime behavior.

## Not found

No record authorizes changing `agentHomePaths()` precedence, removing Codex discovery, or excluding
host profiles in production. No duplicate todo exists. No specification specifically requires a
runtime E2E for this fixture-isolation change.
