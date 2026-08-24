# Codex apply permissions brief

## Problem

The request asks for Codex to have the Claude-style dangerous bypass option when cezar runs it, so that Codex never asks for permissions. In this repository, Codex is not run through `codex apply`: cezar starts a long-lived `codex app-server` process and configures each thread through JSON-RPC. The requested non-interactive full-access behavior already exists by default, so a new `codex apply` argv flag would not reach the active execution path.

## Record already decided

- The current permission-modes decision defines the default `auto` mode as unrestricted for every backend. For Codex, that is exactly `sandbox: danger-full-access` plus `approvalPolicy: never`. [KB `specs-0e61a6fed48e`; `.ai/specs/2026-07-17-permission-modes.md:9-27,113-118`]
- Codex has only sandbox and approval-policy controls, not a per-tool allowlist. The approved design therefore treats Codex as mode-only and rejects vendor-config passthrough. [KB `specs-0e61a6fed48e`; `.ai/specs/2026-07-17-permission-modes.md:64-71,83-92,131-145`]
- Closed issue #563 implemented the unrestricted Codex default in commit `fbeca7285d7c4bfd7fc1ff4ad60f0d09b0e8c417` (`fix(codex): default to full permissions (#563)`). The broader permission-modes work remains the owner of normalization and restrictive modes. [`.ai/specs/2026-07-17-permission-modes.md:319-324`; commit `fbeca728`]
- The nearest Claude precedent is explicitly limited to Claude. It unconditionally selects `--permission-mode bypassPermissions` and says a user-facing control belongs in the still-unimplemented permission-modes spec. [`.ai/specs/2026-08-15-bypass-permissions-claude-sessions.md:1-16,103-121`; commit `7e166fb3a51d11836f0ed50bb4fead32a77de111`]
- The product domain record confirms cezar is a local coding-agent cockpit with provider-specific runners and a review gate, and that Codex is currently enabled on the production host. [KB `notion-711b57ca383e`; `domains/cezar.md`, "What it is" and "Current state"]

## Code involved now

- `packages/cezar/src/core/codex-app-server-transport.ts:19-37` resolves the executable and spawns it only as `codex app-server`. No `codex apply` invocation exists.
- `packages/cezar/src/core/codex-app-server-runner.ts:63-76` documents the autonomous default and the lack of a Codex per-tool allowlist.
- `packages/cezar/src/core/codex-app-server-runner.ts:402-413` sends `approvalPolicy: 'never'` and selects `danger-full-access`, except when `CEZ_CODEX_NETWORK=0` deliberately selects `workspace-write`.
- `packages/cezar/src/core/__fixtures__/codex/mock-codex-app-server.mjs:70-81` makes that JSON-RPC payload contractual in tests. `packages/cezar/src/core/codex-ui-mapper.test.ts:916-948` covers the unrestricted and network-restricted paths.
- `packages/cezar/src/core/agent-runner.ts:38-84` currently has no generic permissions field, so no existing CLI or workflow surface can accept a user-selected Codex permission mode.

## Constraints and possible contradiction

Adding a vendor-specific `codex apply --dangerously-bypass-permissions` flag would contradict the execution architecture because cezar never starts `codex apply`. It would also bypass the approved backend-neutral permission-mode design. The existing `CEZ_CODEX_NETWORK=0` behavior is non-interactive but intentionally not full access, so it must not be described as equivalent to the full-access default.

Workflow `allowedTools` cannot be presented as a restriction for Codex: the runner deliberately ignores it. The record also identifies the analogous Claude allowlist limitation as unresolved pending a deny-set decision. [KB `notion-ecc123f96bb8`; `.ai/specs/2026-08-15-bypass-permissions-claude-sessions.md:13-16`]

## Related work and gaps

No active todo duplicates this request (`cezar todo list`, 2026-08-24). Issue #563 is closed. Permission-modes issue #475 is the related open broader feature. No evidence was found of a current `codex apply` code path, a user-facing Codex permissions flag, or a focused test of a new user-selected mode.

## Open questions for the spec

1. Is the desired outcome to document and runtime-verify the existing no-prompt Codex default, or to expose a visible user control that selects it?
2. If a user control is required, should the next step implement the approved backend-neutral permission-mode design instead of a Codex-specific option?
3. Must `CEZ_CODEX_NETWORK=0` remain as the explicit sandbox restriction, or should the requested behavior remove it? It currently leaves approvals disabled in either case.
4. What real cockpit E2E will prove that a spawned Codex session performs a command and file change without pausing for approval? Existing unit assertions of RPC payloads are not that proof.

## Most constraining facts

1. Codex already runs with `danger-full-access` and `approvalPolicy: never` by default.
2. Cezar uses `codex app-server`, not `codex apply`, so a CLI apply flag has no current call site.
3. The approved permission-modes record requires a backend-neutral design and identifies Codex as mode-only.
4. `CEZ_CODEX_NETWORK=0` is a deliberate non-interactive restriction that changes sandbox access only.

