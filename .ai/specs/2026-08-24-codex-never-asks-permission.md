# Codex never asks for permission: cezar answers the approval requests it currently ignores

**Status:** Implemented (QA Needed: runtime E2E not run)
**Date:** 2026-08-24
**Repo:** `cezar`
**Owner request:** "when running codex apply similar option as in claude --dangerously bypass
permissions to not ask for any permissions"
**Extends:** `.ai/specs/2026-08-15-bypass-permissions-claude-sessions.md` (the Claude precedent this
mirrors, commit `7e166fb3`), `.ai/specs/2026-07-17-permission-modes.md` (the approved
backend-neutral design, `auto` = unrestricted on every backend; codex is mode-only),
`.ai/specs/2026-08-24-codex-step-model-and-effort.md` (the `codex app-server
generate-json-schema` evidence method reused here).
**Brief:** `.ai/specs/briefs/2026-08-24-codex-apply-permissions.md` (step 1 of this run).

## TLDR

Codex already *asks* not to be asked: `thread/start` and `thread/resume` send
`sandbox: danger-full-access` + `approvalPolicy: 'never'`
(`packages/cezar/src/core/codex-app-server-runner.ts:405-413`, #563, commit `fbeca728`). That is
the request. It is not enforcement.

The gap is on the other side of the wire. The app-server can send the client **five** kinds of
approval request, and cezar answers **none** of them. `dispatch()`
(`codex-app-server-runner.ts:490-498`) special-cases exactly one server→client request,
`item/tool/requestUserInput`; every other request, including
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval` and (new in this codex
version) `item/permissions/requestApproval`, falls into `handleNotification`, whose `switch` ends
in `default: break`. A JSON-RPC **request** treated as a notification is never answered, so codex
blocks that item forever. The run does not prompt and does not fail: it goes silent until the
inactivity watchdog (`codex-app-server-runner.ts:200-220`) interrupts it and reports
`stopReason: inactivity`, minutes later, with no note saying why.

So the Codex analogue of `--dangerously-skip-permissions` is not another thread-level flag. It is:
**answer every approval request with the most permissive decision the request itself offers, and
never leave a server request unanswered.** That is what this spec adds, one pure responder module,
one branch in `dispatch()`, no config key, no env var, exactly as the Claude precedent added one
value and no knob.

## Problem

### 1. The current guarantee is a request to the vendor, not a property of cezar

`approvalPolicy: 'never'` is valid in the installed CLI (see the API contracts section: `codex-cli
0.147.0`, `AskForApproval` = `untrusted | on-request | never | {granular}`), and there is no
config-file override fighting it: both codex homes on `prod-host`
(`/var/lib/cezar/.codex`, `/var/lib/cezar/.codex-secondary`) contain **only** `[projects."…"]
trust_level` entries, 129 of them in the primary, and zero non-project keys
(`grep -v 'trust_level\|^\[projects\|^$' ~/.codex/config.toml` → empty, 2026-08-24).

But "the vendor promised not to ask" and "cezar cannot be stopped by being asked" are different
properties, and only the second one survives a vendor change. `AskForApproval` in 0.147.0 is no
longer the flat enum the 2026-07-17 research recorded: `on-failure` is gone, and a `granular`
variant has appeared with **five independent switches**, `mcp_elicitations`, `rules`,
`sandbox_approval`, `request_permissions` (default `false`), `skill_approval` (default `false`).
Approval is now multi-dimensional, `never` is the scalar shorthand, and a scalar shorthand over a
five-field struct is exactly the kind of surface that grows a new dimension in a point release.
When it does, cezar's failure mode is a hang.

### 2. The failure mode is silence, and silence is the worst one available

Three things compound:

- **No prompt.** cezar renders nothing: the reserved `permission.requested` UiEvent
  (`packages/cezar/src/core/ui-events.ts:362-370`, docblock at `:362`, with the counterpart
  `permission.resolved` at `:372-380`) has no emitter, by design, the permission-modes spec owns
  it. The only references to it are the reserved-status tests. (The `ui-events.ts:122` cite in
  `2026-07-17-permission-modes.md`'s current-state table is stale: line 122 is `FileDiff.newText`.)
- **No error.** `handleNotification`'s `default: break` drops the frame without a note.
- **No fast failure.** The item just never completes. `bump()` restarts the silence clock on every
  frame received, so the run dies at the idle limit and is reported as `inactivity`, a stop reason
  that points the reader at "the agent stalled", not at "cezar owed codex an answer".

This is the same class as the Claude precedent's "an inert switch reads as live": here an
unanswered request reads as a stalled agent.

### 3. It has not been observed, and the spec should say so

No live evidence of any approval request reaching cezar on this box: `grep -c requestApproval
~/.codex/logs_2.sqlite` → `0`, and across every run NDJSON under
`/var/lib/cezar/loki-labs/*/.ai/cezar/runs` the single hit
(`cezar/.ai/cezar/runs/49a5aea3-….ndjson`) is an agent reading the `ui-events.ts` docblock, not a
wire frame. So this is a **latent** defect: proven reachable from the protocol schema of the
installed binary, not from an incident. The verification section is written to close that gap
deliberately (a scripted mock request, plus a real run), rather than shipping on a schema argument
alone.

### 4. An adjacent stale doc, found while reading

`.env.example:130-132` still documents `CEZ_APPROVAL_GATE=1` as a live way to "opt back into
Claude's interactive approval UI". It was **removed** on 2026-08-15 (spec
`2026-08-15-bypass-permissions-claude-sessions.md` D2, `BACKWARD_COMPATIBILITY.md` § 1); a test
enforces that the name is absent from `packages/cezar/src`
(`claude-cli-runner.test.ts:578-602`), and README no longer mentions it, but `.env.example`, which
AGENTS.md § Zero config calls "the env contract's single documentation surface", was missed. It is
one edit, it is in exactly this subject area, and leaving it is the failure the original spec
argued against.

## Solution

### D1: the thread-level posture stays, unchanged and now schema-verified

The thread-level posture sent on both `thread/start` and `thread/resume` remains the first line
(`codex-app-server-runner.ts:405-413`), and this spec changes neither value:

- `approvalPolicy: 'never'` is sent **unconditionally**.
- `sandbox` is `danger-full-access` **except** when `CEZ_CODEX_NETWORK=0` selects
  `workspace-write` (`codex-app-server-runner.ts:411`). That conditional is deliberate, D5 keeps
  it, and `codex-ui-mapper.test.ts:930-947` enforces it. Nothing here licenses deleting it.

Both values are confirmed against the installed CLI's own generated schema (`SandboxMode`,
`AskForApproval`, see API contracts). This spec adds the second line of defence, it does not
replace the first.

### D2: cezar answers every approval request, with the most permissive decision offered

New pure module `packages/cezar/src/core/codex-approvals.ts`:

```ts
export type CodexServerRequestReply =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string } };

export function codexApprovalReply(
  method: string,
  params: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): CodexServerRequestReply | undefined;   // undefined = not an approval request
```

Per method (shapes cited in API contracts):

| method | reply |
| --- | --- |
| `item/commandExecution/requestApproval` | `{ decision: pick(params.availableDecisions) }`, `acceptForSession` when the list is absent/null or contains it, else `accept` when the list contains it, else `accept` **plus a note naming the decisions that were offered** |
| `item/fileChange/requestApproval` | `{ decision: 'acceptForSession' }` |
| `item/permissions/requestApproval` | `{ permissions: grant(params.permissions, env), scope: 'session' }` |
| `execCommandApproval` (v1) | `{ decision: 'approved_for_session' }` |
| `applyPatchApproval` (v1) | `{ decision: 'approved_for_session' }` |

`acceptForSession` over `accept` is deliberate: it populates codex's session-scoped approval cache,
so a repeated command stops round-tripping at all. Choosing from `availableDecisions` rather than
hardcoding is what keeps this correct when codex adds a decision kind: the field is documented in
the schema as "Ordered list of decisions the client may present for this prompt."

### D3: matched by shape, so a new sibling method is approved rather than hung

The dispatcher does not test against a hardcoded list of three, and it does not decide for itself
which methods are approvals. **`dispatch()` calls `codexApprovalReply(method, params, env)` for
every id-bearing request** that is not `item/tool/requestUserInput`, and falls through to D4's
`-32601` **only when that call returns `undefined`**. The matching lives inside the pure responder,
which recognises two disjoint shapes:

1. the two **exact** v1 method names `execCommandApproval` and `applyPatchApproval`. Neither
   carries a `/requestApproval` suffix, so a suffix-only route would drop precisely the two frames
   D2's table says must be answered `approved_for_session`; and
2. **any** method ending in `/requestApproval`.

Clause 2 is what makes an unrecognised sibling (`item/futureThing/requestApproval`) safe: it gets
the command-execution treatment, `acceptForSession`, falling back to `accept`, and a note. Vendor
drift then costs a wrong-but-permissive answer, which the agent's own error handling absorbs,
instead of a silent stall. This is the one place where degrading *looser* is correct: the whole
point of the mode is that nothing stops.

### D4: anything else with an `id` gets an error, never silence

The remaining server→client requests in 0.147.0, `item/tool/call`,
`mcpServer/elicitation/request`, `currentTime/read`, `account/chatgptAuthTokens/refresh`,
`attestation/generate`, `openai/form`, are not approvals and are out of scope. They must still be
**answered**: `{ error: { code: -32601, message: 'cezar does not implement <method>' } }`, plus one
engine note. A named, immediate failure is strictly better than a hang; if one of these turns out
to matter in practice (`account/chatgptAuthTokens/refresh` is the likeliest), the note is what makes
that discoverable, and implementing it is a follow-up spec.

**The catch-all fires only for a frame that carries BOTH a string `method` and an `id`**, i.e.
`typeof msg.method === 'string' && (typeof msg.id === 'number' || typeof msg.id === 'string')`.
"Anything with an `id`" is not the guard, and reading it that way would make cezar reply to
replies. `CodexAppServerRpc.dispatchResponse` (`codex-app-server-transport.ts:71-79`) returns
`false` for a frame whose `id` is not a `number`, whose `result`/`error` are both absent, **or**
whose id has no pending entry, so a late or duplicate *response*, arriving after
`rejectPendingUserInput` or a turn interrupt has already settled and deleted that id, falls
straight through to this same code path. A frame with an `id` and **no** `method` is an orphaned
response: drop it silently, exactly as cezar does today. Writing a `-32601` back at it would put a
reply-to-a-reply on the wire, which the app-server has no pending request for and will itself
ignore or error on.

`item/tool/requestUserInput` keeps its existing handling (`handleUserInputRequest`,
`codex-app-server-runner.ts:500-508`) and is untouched, that one is a genuine question to the
user, cezar has a UI for it (`ask.requested`), and parking on it is the product's own
question/answer path, not a permission prompt.

### D5: `CEZ_CODEX_NETWORK=0` keeps meaning something

Auto-granting `item/permissions/requestApproval` would otherwise silently undo the one explicit
restriction cezar ships: `CEZ_CODEX_NETWORK=0` selects the network-blocked `workspace-write`
sandbox (`codex-app-server-runner.ts:411`, `.env.example:134-136`, README:733) and a granted
profile can carry `network: { enabled: true }`.

So: `grant()` echoes the requested profile back **verbatim**, except that when
`process.env.CEZ_CODEX_NETWORK === '0'` the `network` key is dropped and one note says so. The
filesystem escalation is still granted. This keeps both properties true at once, the run never
prompts, and an operator who asked for no network still has no network. `CEZ_CODEX_NETWORK` is
**not** removed: unlike `CEZ_APPROVAL_GATE`, it is not inert, and it never causes a prompt (under
`never` a sandbox-denied command fails, it does not ask).

### D6: no knob

No config key, no env var, no `AgentRunSpec` field, no settings UI. Mirrors the Claude precedent's
D1/D5 exactly: the mode is a property of what cezar *is*. A user-facing control still belongs to
`.ai/specs/2026-07-17-permission-modes.md`, which stays unimplemented; when it lands, this
responder becomes the `auto` preset's codex branch and the restrictive presets get their own
non-auto answers. Nothing here blocks that: the responder is a pure function of
`(method, params, env)`, so adding a mode argument later is a signature change in one file.

### D7: the timeline says what cezar answered

Every auto-approval emits the existing `note` AgentEvent (the engine-note channel the
permission-modes spec already designates for this) naming the method and the decision, e.g.
`codex asked to approve a command; cezar auto-approved (acceptForSession), bypass permissions`.
Capped at `MAX_APPROVAL_NOTES = 10` per session, after which one final note says further approvals
are auto-approved silently; an escalation loop must not be able to flood a run's timeline.

### D8: delete the stale `CEZ_APPROVAL_GATE` block from `.env.example`

Doc-only, and marked in the CHANGELOG as a correction to the 2026-08-15 removal rather than a new
change. Guarded by a test (below) so the next removal cannot miss this surface again.

## Architecture

```
codex app-server (0.147.0)                     cezar
  │
  ├─ notification  ──────────────────────────► mapCodexNotification / handleNotification   (unchanged)
  │
  ├─ request  item/tool/requestUserInput ────► handleUserInputRequest → ask.requested       (unchanged)
  │                                             └─ answered by the user, via the cockpit
  │
  ├─ request  *​/requestApproval ─────────────► codexApprovalReply()      ◄── NEW
  │     (commandExecution │ fileChange │        └─ rpc.respond({id, result:{decision|permissions}})
  │      permissions │ v1 execCommand │            + engine note (capped)
  │      v1 applyPatch │ future sibling)
  │
  └─ request  anything else with an id ──────► rpc.respond({id, error:-32601}) + note       ◄── NEW
        (item/tool/call, mcpServer/elicitation/request, currentTime/read, …)
```

- **What changes:** `packages/cezar/src/core/codex-approvals.ts` (new, pure),
  `codex-app-server-runner.ts` `dispatch()` (`:490-498`) plus its class docblock (`:63-76`),
  `src/core/__fixtures__/codex/mock-codex-app-server.mjs` (scripted approval request),
  `codex-ui-mapper.test.ts` (integration guards), a new `codex-approvals.test.ts`,
  `.env.example`, `README.md:733`, `CHANGELOG.md`.
- **What is reused:** `CodexAppServerRpc.respond()` (`codex-app-server-transport.ts:68-70`), the
  same writer `handleUserInputRequest` already answers with; the `note` AgentEvent channel; the
  mock-fixture-plus-real-runner test pattern that `codex-ui-mapper.test.ts:916-948` uses for the
  existing permission assertions.
- **The mapper needs no edit, and here is why, so nobody goes looking:** `mapCodexNotification`
  already sees these frames and deliberately maps them to zero UiEvents, asserted at
  `codex-ui-mapper.test.ts:100` (`{id: 3, method: 'item/commandExecution/requestApproval'}` in the
  "produces nothing" table). That stays true after this change: the answer is written by the
  runner via `rpc.respond()`, and the only new UiEvent is a `note`. Do not add a mapper case.
- **What does NOT change:** the `AgentRunSpec` seam (`core/agent-runner.ts:38-84`), `config.ts`,
  the workflow schema, every route, the whole web app. No backend type leaks past the seam because
  nothing new crosses it.
- **Threading:** approvals are answered for **any** `threadId`, including sub-agent child threads.
  The `isForeignTurnLifecycle` filter (#600) deliberately drops child *turn lifecycle*
  notifications; it must not be extended over approvals, an unanswered child approval hangs the
  child, which hangs the parent's tool call.

## Data Models

None. No config key, no `RunRecord` field, no new persisted state, no new UiEvent type (the
reserved `permission.requested` stays unemitted and unchanged, activating it belongs to
`2026-07-17-permission-modes.md` Phase 1.11, and emitting it here without a card to render it or a
route to answer it would be worse than the note).

## API Contracts

No cezar HTTP route changes. The contract is the codex app-server JSON-RPC surface, taken from the
installed CLI rather than from documentation:

```
codex --version                                   # codex-cli 0.147.0
codex app-server generate-json-schema --out /tmp/cez-spec-probe/schema --experimental
```

**Server→client requests** (`ServerRequest.json`, all eleven variants): `item/commandExecution/
requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`,
`item/tool/requestUserInput`, `item/tool/call`, `mcpServer/elicitation/request`,
`account/chatgptAuthTokens/refresh`, `attestation/generate`, `currentTime/read`,
`openai/form`, and the v1 pair `execCommandApproval` / `applyPatchApproval`.

**`CommandExecutionRequestApprovalParams`**: required `itemId`, `startedAtMs`, `threadId`,
`turnId`; also `command`, `commandActions`, `cwd`, `reason`, `approvalId`, `availableDecisions`,
`additionalPermissions`, `proposedExecpolicyAmendment`, `proposedNetworkPolicyAmendments`,
`networkApprovalContext`, `environmentId`.
**`CommandExecutionRequestApprovalResponse`**: `{ decision }`, required, where
`CommandExecutionApprovalDecision` is `"accept" | "acceptForSession" |
{ acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } } |
{ applyNetworkPolicyAmendment: { network_policy_amendment: { host, action: "allow"|"deny" } } } |
"decline" | "cancel"`.

**`FileChangeRequestApprovalParams`**: required `itemId`, `startedAtMs`, `threadId`, `turnId`;
also `grantRoot`, `reason`. **Response**: `{ decision }` where `FileChangeApprovalDecision` is
`"accept" | "acceptForSession" | "decline" | "cancel"` (no object variants, no
`availableDecisions`).

**`PermissionsRequestApprovalParams`**: required `cwd`, `itemId`, `permissions`, `startedAtMs`,
`threadId`, `turnId`; `permissions` is a `RequestPermissionProfile` = `{ fileSystem?:
AdditionalFileSystemPermissions | null, network?: AdditionalNetworkPermissions | null }`.
**Response**: `{ permissions: GrantedPermissionProfile, scope?: "turn" | "session" (default
"turn"), strictAutoReview?: boolean | null }`; `GrantedPermissionProfile` has the **same two
fields** as the requested profile, which is what makes echo-back structurally valid.
`AdditionalNetworkPermissions` is `{ enabled?: boolean | null }`, the key D5 strips.

**v1 `ExecCommandApprovalResponse` / `ApplyPatchApprovalResponse`**: `{ decision: ReviewDecision }`
where `ReviewDecision` is `"approved" | "approved_for_session" | "denied" | "timed_out" | "abort" |
{ approved_execpolicy_amendment } | { network_policy_amendment }` (snake_case here, camelCase in
the v2 pair, do not unify them).

**`ThreadStartParams` / `ThreadResumeParams`** (what cezar already sends): `sandbox` is
`SandboxMode = "read-only" | "workspace-write" | "danger-full-access"`; `approvalPolicy` is
`AskForApproval = "untrusted" | "on-request" | "never" | { granular: { mcp_elicitations, rules,
sandbox_approval, request_permissions = false, skill_approval = false } }`. Both nullable. Note
also `permissions: string | null`, "Named profile id for this thread. **Cannot be combined with
`sandbox`**", a newer mechanism cezar does not use and must not start using casually, since it is
mutually exclusive with the sandbox key it depends on today.

## Phases

Each phase is independently shippable and independently green.

**P1: the responder, pure and unwired.** `codex-approvals.ts` + `codex-approvals.test.ts`. Table
-driven over every method above, both `CEZ_CODEX_NETWORK` states, `availableDecisions` present /
absent / hostile (only `decline`/`cancel` offered). Nothing calls it yet; the runner is untouched.

**P2: wire it into `dispatch()`.** The `/requestApproval` suffix branch, the `-32601` catch-all for
any other `id`-bearing request, the capped notes. `mock-codex-app-server.mjs` gains a
`MOCK_CODEX_APPROVAL=<command|file|permissions>` script that emits the matching request mid-turn and
**only completes the turn once a valid response arrives**, so the mock is the negative control:
delete the branch and the test hangs to its timeout instead of quietly passing. Runner-level tests
in `codex-ui-mapper.test.ts` beside the existing full-access ones.

**P3: docs and the adjacent correction.** README:733 backend-table cell (say cezar auto-answers
approval requests, not just that it asks for full access); `.env.example`, delete the
`CEZ_APPROVAL_GATE` block (D8), extend the `CEZ_CODEX_NETWORK` note with the D5 network-strip
behaviour; AGENTS.md only if a permissions row exists there; `BACKWARD_COMPATIBILITY.md`, no
protected surface changes, so a one-line behavioural note under § 1's env-var discussion, not a new
protected entry; CHANGELOG under 🐛 Fixes (the hang) + a line for the D8 doc correction.

**P4: runtime E2E.** Below. This is the gate on Done; P1–P3 green is "QA Needed", not done.

## Risks

- **Blast radius widens beyond the worktree, on purpose.** `item/permissions/requestApproval` can
  ask for filesystem roots outside the worktree, and cezar will now grant them for the session. The
  containment that remains is codex's own sandbox model plus `--`-style cwd scoping, not an approval
  gate. This is the requested posture, stated plainly here rather than discovered later, the same
  sentence the Claude precedent's Risks section had to write.
- **Erroring a non-approval request could break a future codex feature.**
  `account/chatgptAuthTokens/refresh` is the one that could plausibly matter (a token refresh
  cezar refuses could fail a long run). Chosen anyway: today those requests hang forever, so
  `-32601` + a named note is strictly better, and it is the only version of this that is
  *discoverable*. Follow-up if a note ever appears in a real run.
- **`acceptForSession` may not be offered.** `availableDecisions` is nullable and ordered; a future
  prompt kind could offer only object variants. The fallback answers `accept` and notes what was
  offered, so the failure is visible rather than silent, but it is a guess, and the note is what
  makes the next reader able to fix it.
- **Vendor drift in the decision enums.** v1 uses snake_case (`approved_for_session`), v2 uses
  camelCase (`acceptForSession`), and the two live side by side in one schema bundle. One
  translation table, table-driven tests, regenerate the bundle when codex is upgraded.
- **Not observed in the wild.** Nothing on this box has ever received one of these requests
  (§ Problem 3). If P4's real run also never triggers one, the honest report is "the hang is closed
  by construction and proved against the mock; the real-run leg proved the no-prompt posture, not
  the responder". Do not round that up.
- **This is not the permission-modes feature.** It deliberately makes codex *less* interruptible,
  which is the opposite direction from `.ai/specs/2026-07-17-permission-modes.md`'s restrictive
  presets. Recorded there when this lands (a "Current state" table row edit for codex), so that
  spec's Phase 1.11 does not read as if nothing answers these requests.

## Verification

Every guard names the mutation that must turn it red, no guard is listed that a broken
implementation would still pass.

| Guard | Mutation that must turn it red |
| --- | --- |
| `codexApprovalReply('item/commandExecution/requestApproval', {availableDecisions:['accept','acceptForSession','decline']})` → `{decision:'acceptForSession'}` | return `accept`, or `decline` |
| Same method with `availableDecisions: null` → `{decision:'acceptForSession'}` | treat a null list as "nothing offered" and decline |
| Same method with `availableDecisions: ['accept']` → `{decision:'accept'}` | keep returning `acceptForSession` |
| `item/fileChange/requestApproval` → `{decision:'acceptForSession'}` | return the v1 `approved_for_session` (wrong casing/enum for v2) |
| `item/permissions/requestApproval` echoes the requested profile with `scope:'session'` | drop `scope`, or return `{}` |
| With `CEZ_CODEX_NETWORK=0`, the granted profile has **no** `network` key while `fileSystem` survives | pass the profile through unmodified |
| Without `CEZ_CODEX_NETWORK`, `network` **is** granted | strip it unconditionally |
| `execCommandApproval` / `applyPatchApproval` → `{decision:'approved_for_session'}` | reuse the v2 camelCase value |
| Integration: a frame `{id, method:'execCommandApproval'}` from the mock is answered `{decision:'approved_for_session'}`, **not** `-32601` | route only `*/requestApproval` to the responder (the D3 suffix-only trap: both v1 names lack the suffix) |
| An unknown sibling `item/futureThing/requestApproval` is still approved (D3) | match the three literal method names only |
| A non-approval request (`mcpServer/elicitation/request`) gets a `-32601` **response**, not silence | fall through to `handleNotification` |
| A request with **no** `id` (a true notification) is NOT responded to | respond to every frame carrying a `method` |
| An orphaned response frame (`{id: 99, result: {}}` with no pending request and no `method`) is NOT responded to | route on `id` alone, so cezar replies -32601 to a response |
| Notes stop after `MAX_APPROVAL_NOTES` with one summary note | emit unboundedly |
| Integration: mock emits `item/commandExecution/requestApproval` mid-turn and completes the turn only after a valid response, `session.result` resolves | remove the `dispatch()` branch → the test hangs to its timeout (this is the negative control, and it must be observed failing once before the branch lands) |
| An approval carrying a **foreign** `threadId` (sub-agent child) is still answered | extend `isForeignTurnLifecycle`-style filtering over approvals |
| No file in `.env.example` mentions `CEZ_APPROVAL_GATE` (mirrors `claude-cli-runner.test.ts:593`) | leave the block in |

Gates, in this order, `npm test -- <path>` and never `npx vitest`; `npm test` is judged by its
**exit code**, not its pass count:

```
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

### Runtime E2E: the gate on Done

Reading argv or an RPC payload out of a test does not answer whether a **spawned** codex session
behaves. On `prod-host`:

1. Start a real cockpit run on the `cezar` project with the **codex** backend, in a fresh task
   worktree. Note that a worktree path is *not* in `~/.codex/config.toml`'s 129 trust entries
   (`grep -c worktrees ~/.codex/config.toml` → `0`), so this also exercises the untrusted-project
   path.
2. The task must do all three things codex can gate: write a file, run a shell command, and make a
   network request (e.g. `curl -sS https://api.github.com/zen`).
3. Pass = the run reaches its terminal state with **no** park, no `waiting`, and no
   `stopReason: inactivity`.
4. Evidence, from the run's own record rather than from the UI:
   `grep -c 'requestApproval\|auto-approved' .ai/cezar/runs/<runId>.ndjson`, report the number
   either way. `0` means the thread-level posture held and the responder was never exercised
   (state that plainly; it is not proof the responder works). `>0` with the run still completing is
   the strong result: codex asked, cezar answered, nothing stopped.
5. Repeat the same task once under `CEZ_CODEX_NETWORK=0`, through the **headless terminal path**,
   and explicitly **not** through the cockpit. There is no per-run env for this variable:
   `codex-app-server-runner.ts:411` reads the `process.env` of the cezar **server** process, and
   `buildCodexAppServerEnv` (`codex-app-server-transport.ts:23`) injects only backend/account env
   into the child, so nothing carries a per-run value down. Setting it for a cockpit run therefore
   means editing the systemd unit and restarting cezar on `prod-host`, which kills every
   in-flight run. Do not do that for a test. `cezar run` executes the workflow in-process with no
   server at all (`AGENTS.md:200`, dispatch at `packages/cezar/src/index.ts:380`), so it reads the
   caller's env directly.

   **There is no `--backend` flag.** `case 'run'` passes only `values.workflow` and `values.model`
   (`packages/cezar/src/index.ts:381`), and the top-level `parseArgs` is strict with no `backend`
   key (`:309-350`); the code's own comment at `:290-294` names `--backend` among the options that
   strict parse rejects, so `cezar run --backend codex …` exits `Unknown option '--backend'` before
   any run starts. Headless backend selection is per-step `runner` in a workflow
   (`workflows/types.ts:75`, `runner: z.enum(RUNNER_IDS)` where `RUNNER_IDS` includes `codex`,
   `agent-runner.ts:25`), loaded from `.ai/cezar/workflows/*.yaml` (`workflows/load.ts:14`), or
   `config.defaultRunner` (`config.ts:104`). Use the workflow route: `.ai/cezar/` is gitignored
   (`.gitignore:11`) so the file is not repo content, and it avoids changing the project default
   that the running cockpit reads.

   ```
   cd /var/lib/cezar/loki-labs/cezar
   mkdir -p .ai/cezar/workflows
   cat > .ai/cezar/workflows/codex-permissions-e2e.yaml <<'YAML'
   name: codex-permissions-e2e
   steps:
     - id: exercise
       runner: codex
       prompt: "{{task}}"
   YAML
   CEZ_CODEX_NETWORK=0 cezar run --workflow codex-permissions-e2e \
     "write a file, run a shell command, and curl -sS https://api.github.com/zen"
   rm .ai/cezar/workflows/codex-permissions-e2e.yaml
   ```

   Delete the temporary workflow file once the run has finished (the `rm` above): it is a
   test fixture, and leaving it behind puts a stray entry in the project's workflow catalog for
   every later cockpit run.

   Pass = the run completes with no park and no `stopReason: inactivity`, and the network step
   fails as a *denied command the agent handles*, not as a prompt. Evidence is the same read as
   step 4: `grep -c 'requestApproval\|auto-approved' .ai/cezar/runs/<runId>.ndjson`, reported
   either way.

