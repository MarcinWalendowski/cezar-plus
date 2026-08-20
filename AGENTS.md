# AGENTS.md — working in this repository

cezar is a **parallel coding-agents orchestrator**: a local cockpit (CLI + browser GUI) for running and tracking AI coding-agent tasks in a repo. You type a task, pick a workflow and a backend — Claude Code, Codex or OpenCode (experimental), or a mix per step — and watch it work live: steps, tool calls, tokens, diffs. Each task runs in its own git worktree, ends at a review gate (never auto-merges), and can be pushed as a draft PR through `gh`. Everything is local: no accounts, no database, no cloud — state is plain JSON, NDJSON and Markdown under `.ai/cezar/`. The server stack stays deliberately small: strict TypeScript (ESM, Node 20+), Hono + SSE, Zod at every boundary, and YAML workflows. The cockpit is React 19 + Vite + Tailwind v4 + shadcn/ui, compiled to static assets (the legacy vanilla UI was retired in R7). Every module is meant to be read in one sitting.

## Shipping cezar itself — standing authorization

**Owner instruction 2026-08-19: every change to cezar is always committed, pushed, and deployed — the full loop, no per-session ask.** This is standing authorization to `git commit`, `git push` to `origin main`, and deploy (`cezar server-deploy`); it supersedes the earlier "cezar is outside standing push authorization" caveat. The default workflow is `spec-to-deploy` (spec `.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md`), which runs read→spec→implement→run-tests→commit-push→document→deploy, so a task on cezar ships end to end by default.

This applies to **developing cezar**; it does not change what cezar does for the tasks it RUNS for users — those still end at the review gate and never auto-merge (see the intro). Two hard rules stay in force:

- **Gates first, fail closed.** Never commit/push/deploy a red build. Typecheck + lint + tests green is the precondition for the commit-push step, and the deploy step must gate on a real readiness probe and never ship a broken build. **Since 2026-08-20 (`57fc8807`) this is enforced, not just asked for:** the `commit-push`, `document` and `deploy` steps of `spec-to-deploy` carry `verify` post-conditions (`packages/cezar/src/workflows/postconditions.ts`) and are green only when a machine-checkable condition holds afterwards — nothing uncommitted and nothing unpushed for the first two, and for `deploy`, **every** probe in `.ai/deploy-targets.json` exiting 0. cezar is TWO services and that file declares both, so shipping the UI without the backend now fails the step instead of ending it green. A repo with no `.ai/deploy-targets.json` gets a RED deploy step by design; write the file. **One deliberate carve-out, since `2e421370` (2026-08-20): under `CEZ_DRY_RUN=1` every post-condition short-circuits green with a `simulated, not verified` verdict.** A dry-run agent is a mock that commits and deploys nothing, so evaluating its post-conditions for real killed every dry run at `commit-push` and broke `npm run test:package` and `npm run test:e2e` on every branch. The unknown-builtin-id check still runs first, so a workflow naming a post-condition that does not exist still fails in a dry run — but a dry run proves the SHAPE of a workflow, never its post-conditions, and a green dry run is not evidence that anything was committed or deployed. See `.ai/specs/2026-08-20-steps-green-only-when-verified.md`.
- **Always self-deploy — including from inside a running cockpit session.** *(Owner instruction 2026-08-20. The earlier rule that withheld self-deploy until the non-disruptive path landed is WITHDRAWN — it is no longer a caveat, a gate, or a thing to wait for.)* Every change ships the moment its gates are green — no quiet window, no handing the restart to a human, no waiting on `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`. On the prod host `cezar server-deploy`'s `systemctl restart` needs sudo the service user does not have, so the working path is: build → **readiness-probe the DEPLOYED tree before touching the service** (`await import()` its server module graph, so a broken build is still one `mv` from rollback) → back up and swap `dist` / `web/dist` into `/opt/cezar` → `git rev-parse HEAD > /opt/cezar/.deployed-commit` (a bare sha, nothing else — the `all-services-deployed` post-condition string-compares it) → `kill -9` the unit's MainPID (`Restart=on-failure` brings it back in ~5s). A **web-only** change skips the restart entirely: the server reads web assets per request, so the swap is live on the next one. A **backend** change does need the restart, and that restart SIGKILLs the deploying session's own process group — this is **expected and survivable**, not a reason to defer: restart-continuation (`.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md`) resumes the run, which then verifies its own deploy, and resumes any foreign run that was in flight too. Verified unattended end-to-end on 2026-08-20 (`8a34f20d`, ~5s outage). One thing that is correctness rather than caution: if the delta changes `package.json` / `package-lock.json`, a `dist`-only swap is NOT sufficient — install into `/opt/cezar` as well.

## Zero config

cezar ships no config file the user must create and no setting they must set before it works. Every capability is discovered from what is already there — the repo, the environment, `gh`, the running processes — or it degrades quietly to a smaller cezar. `.ai/cezar/config.json` is optional and every key has a working default; `.env` is never auto-loaded.

New state may be **written**, never **required**: `.ai/cezar/`, `~/.cache/cez/`, `~/.cezar/`. Delete any of them and cezar rebuilds what it needs on the next run. State that a user must author, migrate, or repair is not state — it is configuration, and it needs a reason. One deliberate exception inside that rule: the project registry keeps a `~/.cezar/config.json.bak` snapshot, so deleting `config.json` alone restores instead of resetting — delete the `~/.cezar` directory for a true reset.

Practical rules:

- When a feature seems to need configuration, the design is wrong. Discover it, or default it.
- Features that widen exposure or cost (network, other processes) are opt-in behind a `CEZ_*` flag, off by default — the zero-config default is also the safe default.
- A missing dependency, an absent peer, a read-only home: degrade to a smaller working cockpit, never fail the boot.
- Prefer a proxy-free, daemon-free mechanism when one exists — and when it doesn't, keep the mechanism invisible: no process to manage, no port to remember, no file to edit.
- Never trade a working default for a knob.
- Adding, renaming, or removing a `CEZ_*` env var — or changing what its default does — MUST update `.env.example` in the same commit (and the README env table when the var is user-facing). `.env.example` is the env contract's single documentation surface; an undocumented env var is a bug.

## Changing a mechanism that already works

Replacing working behavior is the highest-risk change in this repo, and it fails in a
characteristic way: the new mechanism is correct, the tests are green, the spec is
thorough — and the DEFAULT path quietly lost a guarantee nobody wrote down. #810 and #811
are the worked examples; both shipped a well-specified improvement that left the
zero-config user worse off than before.

**Name what the old mechanism was load-bearing FOR, not what it was for.** Those are
different questions. `IDLE_TIMEOUT_MS` read as session hygiene, and #661 removed it from
the monitoring branch for a good reason (it was closing live sessions mid-CI and recording
them as `done`). It was also the only liveness bound on `CEZ:MONITORING` and the only
reason a parked monitor eventually stopped holding a `maxParallel` slot. Neither
dependency was named in the spec, so neither was replaced, and `monitoring` became a state
with no exit. Before deleting a timer, lock, cap or timeout, grep for everything that
reaches a terminal state *because* of it. (`2026-08-20-inactive-sessions-stay-in-progress.md`
is the counter-example done right: it stopped the ordinary-wait idle close from recording
`done`, but KEPT the timer's load-bearing role — the process close that bounds memory — and
only changed what the close settles to, `waiting` instead of `done`.)

**A replacement that ships OFF is not a replacement.** Diff the default path, not the
feature. The question is always: *with every new knob at its shipped default, what does
the old scenario do now?* If the answer is "nothing", the change removed a mechanism and
added a setting. A spec's "Resolved assumptions" table answering a COST question with
"opt-in, default null" is not an answer to whether the zero-config path still works —
cost-safe and functional are separate reviews. See § Zero config: *never trade a working
default for a knob*.

**Enumerate the transitions out of every state you add or keep.** "Who fires this?" is the
question that finds these bugs in one step. A parked run has exactly three wake sources —
a user message (`deliverMessage`), the autonomous nudge (turn-end only), and the monitoring
wake timer. Cezar has no process-exit callback, no CI webhook and no sub-agent-completion
event, so a state whose only on-by-default exit is "a human types something" is a dead end,
however well it renders.

**Two handlers, one guard, is the same bug at rest.** `runAgentStep`'s turn-end has honoured
`CEZ:DONE` only on the chain's LAST step since #410; `runContinuation`'s near-identical
turn-end honoured it unconditionally. That asymmetry was defensible while a continuation only
ever existed *after* a chain had finished. Then #367's restart recovery started creating
continuations mid-chain, and the guard nobody had copied became the reason run `be31d9e9` was
marked `done` after step 1 of 6 — twelve project worktrees applied back, five steps including
the commit and the deploy silently dropped
(`.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md`). The guard was correct
where it lived; the defect was that it lived in one of two places. When you find a guard on one
of a pair of twins, the question is not "is this one right?" — it is "what changed since, that
now reaches the other one?"

**When a default changes the SHAPE of the workload, audit every bound written against the
old shape.** The same day and the same run produced two P0s that are one lesson. Both were
old code, correct for years, made false by commit `097d1b15` making the six-step
`spec-to-deploy` the default for every run path: (a) "session done = run done" — true when a
run had one step, data-losing across six
(`.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md`); (b) "only the chain's
LAST step gets `timeoutMs: 0`, so nothing important is capped" — true when the single step WAS
the last step, and a routine killer once four earlier steps carried a 30-minute wall clock that
real `implement` and `run-tests` work exceeds
(`.ai/specs/2026-08-20-agent-step-inactivity-timeout.md`). Neither was a new bug; both were
latent branches becoming reachable. A one-line default flip is not a small diff — it is a
change of workload shape, and the review it needs is a sweep of every timeout, cap, lock and
"the last one" assumption written when the old shape was true.

**A bound on a working process must measure health, not elapsed time.** The 30-minute step cap
was a `setTimeout` armed at spawn that nothing ever reset, so it killed a busy agent and a
wedged one identically, and wrote `failed` on both. It now re-arms on every line the agent
emits — `DEFAULT_RUN_IDLE_TIMEOUT_MS`, ~~all three runners~~ **all four runners** — and says
`produced no output for 30m`, a diagnosis rather than an accusation. The reaping guarantee is
unchanged, because a wedged CLI holding a `maxParallel` slot is exactly the silent case. Note
what was NOT done: `timeoutMs: 0` for every step would have removed the only thing that reaps a
non-interactive step, which `IDLE_TIMEOUT_MS` never covers because such a step is never parked
at `waiting`. Bound the failure mode you actually mean; do not delete the bound because it
misfires. (**Corrected 2026-08-20 by `62a41d30`:** "all three runners" was written from the
spec's own file table, which enumerated claude, codex and opencode and stopped. `pi-runner.ts`
was never converted, so a `pi` step kept the wall clock for another day — the defect surviving
on the one backend nobody counted. This is the "grep the TYPE, not the field" lesson below,
arriving as a runner instead of a construction site: when you convert a mechanism, enumerate
its implementations from the type or the factory, never from prose.)

**A stop you chose is not a failure they produced — and a record that cannot tell them apart
costs you the work.** `e3f542df` fixed why steps were being stopped; it left what a stop MEANS
untouched, and that was the expensive half. A stopped step was written `failed`, the run was
written `failed`, and the chain's remaining steps were abandoned into `continue-N` chat — so
on run `9d09795a` a step whose code was written, gates green and commit made read as a defect
in the work rather than a decision by the harness, and the owner had to hand-annotate the
handoff to say so. The runner now reports `reason` on the `error` event when cezar initiated
the stop and nothing at all when the agent genuinely failed; the engine parks the run at
`review` with `stopReason`, leaves later steps `pending`, and re-enters the stopped step once
against the same session (`.ai/specs/2026-08-20-agent-step-stopped-is-not-failed.md`). Two
rules generalise. **Every mechanism that terminates someone else's work owes the record a
reason** — an outcome field alone cannot carry the difference between "it broke" and "we
stopped it", and the next reader will believe the field. And **when you widen what a system
can say, do not widen a published union to say it**: `RunStatus`/`StepStatus` ship in an npm
package and every exhaustive `switch` downstream breaks; a new optional field beside the
status carries the fact and leaves old consumers rendering exactly what they render today.

**A grace window that does not drain is not a grace window.** The SIGTERM→SIGKILL escalation
looked correct and bought nothing: the deadline handler called `stdout.destroy()` immediately
and the read loop broke on the flag, so the ten seconds bought for the CLI to land its final
message, write its handoff and declare `CEZ:SPEC_PATH` discarded all of it — at the one moment
the output matters most, on a process being killed mid-work. Fixed in `62a41d30` (drain to real
end-of-stream), and pinned by a test that goes red if either the `destroy()` or the early break
returns. The spec that shipped the bug had even written the behaviour down, as a note explaining
why a test could not assert escalation. When a test cannot observe the thing the code claims to
do, the first hypothesis is that the code does not do it — not that the harness is awkward.

**Find every construction site of a shared in-memory object — grep the TYPE, not the
field.** `ActiveRun` is built in `execute` AND in `runContinuation`; #811 populated
`state.skills` in the first only, so registry `/skill` expansion worked on new tasks and
silently failed on every Continue and every restart recovery. The same shape recurs in the
two near-identical turn-end handlers in `workflows/run.ts` (streaming and non-streaming):
a lifecycle change applied to one of them ships half a fix. When you add a field that a
delivery path reads, add it everywhere in the same commit or route both sites through one
helper.

**A fail-open helper needs a populated-input guarantee, or it lies.**
`expandRegistrySlashSkill` returning its input unchanged on no-match is right on its own —
a backend's own slash commands must survive. Against an empty registry that same branch
turns "cezar never loaded the list" into a confident user-facing "Unknown skill". Pair
every silent pass-through with a test that pins the *empty/absent input* case.

**Prove the regression test fails without the fix.** `git stash push -- <source files>`,
run the new test, confirm red, `git stash pop`. A test written after the diagnosis passes
against the bug more often than anyone expects, and a green-either-way test is how the
same regression ships twice. Keep the guard tests that pass both ways — they pin the
behavior you did NOT want to change (park mode stays reachable; unknown slashes stay
untouched) — but know which is which.

**Read the run-history evidence before theorizing, and cite it.** `.ai/specs/` records the
design, `git log -S` and `git merge-base --is-ancestor <commit> <tag>` settle "was this in
the release the user is on", and a user's "it worked in 0.9.1" is a testable claim, not an
opinion. #810 was confirmed in one command before a line of code was read.

## The HTTP API

Four invariants. A feature that breaks any of them compiles on its own branch and stops working
when it lands — #694 arrived with eleven unreachable routes for exactly this reason.

- **Every request and response shape is a zod schema in `packages/contract`, with its TypeScript
  type inferred from it (`z.infer`).** Never hand-write an API type, and never declare one in
  `server.ts` or in the api-client. The api-client re-exports the contract; the cockpit imports
  the schema when it wants to validate and the type when it wants to compile.
- **Register routes by CHAINING them into a family builder**, the way the ~24 families in
  `server.ts` already do. Hono accumulates route types through the chain only: a loose
  `app.get(…)` statement returns a value nobody keeps, so the route vanishes from `AppType` and
  the typed client cannot see it — silently, with the server still serving it.
- **Validate bodies, path params and the query string as route MIDDLEWARE**, through the trio in
  `src/server/validators.ts`. Parsing inside a handler is invisible to hono, which is what let
  `POST /runs` accept `{ totalNonsense: 12345 }` from a typed client without complaint.
- **Everything answers under `/api/v1`** (project-scoped: `/api/v1/p/:projectId/…`). The
  unversioned surface is gone.

The contract must describe EXACTLY what the route sends — no wider, no narrower. When a schema and
its route disagree, fix the SOURCE, never widen the schema; `contract-parity*.test.ts` asserts both
directions and a one-way check passes on real drift. Two mismatches recur often enough to name:
writing `key: maybeUndefined` types a key as always-present that `JSON.stringify` drops from the
wire (spread it conditionally), and an object-literal `type: 'x'` widens to `string` during hono's
inference, erasing a discriminant consumers narrow on (`as const`).

## Repository layout

Four npm workspaces under a `private` root that publishes nothing itself:

| Path | Package | What it is |
| --- | --- | --- |
| `packages/cezar` | `@loki-labs/better-cezar` | The service + CLI, and everything behind them (runs, workflows, agent runners, workspace state). The published artifact: `bin`, plus the built cockpit in `web/dist`. |
| `packages/contract` | `@loki-labs/better-cezar-contract` | The HTTP contract itself: every request and response as a zod schema with its TypeScript type inferred from it, so no shape is written twice. **Node-free on the same terms as the api-client** (`lib: ["ES2022"]`, `types: []` in its tsconfig make a `node:*` import a compile error). `private`, and that has a cost: the service imports a contract VALUE (`workspaceUiStateSchema`, in `workspace/migrations.ts`), so a published tarball naming a package npm has never seen would fail on install. `packages/cezar/scripts/inline-contract.mjs` runs as `postbuild` to fold the contract into `dist/contract/` — bundle AND declarations — and repoint the emitted references. Delete that script the day the contract is published, or the day nothing in the service imports a contract value. |
| `packages/api-client` | `@loki-labs/better-cezar-api-client` | The contract between the two: the typed client over `AppType`, the SSE/protocol types, and the scope helpers. Re-exports `packages/contract` so a consumer needs one import. **Node-free by construction** — no `node:*`, no `@types/node` — because it is bundled into a browser AND imported by the Node service. `private` for now: versioned with the release but not on npm. The service may therefore only import it in TESTS — a runtime import would make the published CLI depend on something npm cannot resolve. |
| `packages/web` | `@loki-labs/better-cezar-web` | The cockpit SPA. Private; its output is an artifact of the service (`vite build` writes into `packages/cezar/web/dist`, which the CLI ships and serves). |

Rules that follow from that:

- **The CLI is not a separate package and should not become one.** It is the same program as the service — `packages/cezar/src/index.ts` boots `startServer`, but also `RunManager`, the workspace registry and the worktree machinery, and `cezar run` executes a workflow with no server at all.
- A dependency belongs to the workspace that imports it. The root carries only what spans all four (`typescript`, `vitest`, `tsx`). A build script counts as an importer: `scripts/inline-contract.mjs` reaches for `esbuild`, so `esbuild` is a devDependency of `packages/cezar` rather than something inherited from whatever vite happens to hoist.
- Cross-package imports go through the package name, never a relative path — the exceptions are test-only reaches for golden fixtures, and they are ugly on purpose.
- The repo root keeps only what spans workspaces: `scripts/dev.mjs` (boots both halves) and `scripts/release*.mjs` (a release spans every package). Everything else lives in the package that owns it.

## Task routing

| When the task involves…                                                                                                                                                                                       | Read first                                                                                                                                                                                                                                    | Key rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI entry, `serve`/`run`/`init` subcommands, flags                                                                                                                                                            | `packages/cezar/src/index.ts`                                                                                                                                                                                                                                | Uses `node:util` `parseArgs`, no CLI framework. `serve` is the default command. Headless `run` treats `review` as a terminal success status (exit 0). `init` never overwrites existing files. Keep `.ai/cezar/.gitignore` maintenance (`ensureDataGitignore`) in sync with any new state file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Agent runners / backends                                                                                                                                                                                      | `AGENT_PROTOCOL.md` (the contract), then `packages/cezar/src/core/agent-runner.ts`, `packages/cezar/src/core/runner-factory.ts`, `packages/cezar/src/core/claude-cli-runner.ts`, `packages/cezar/src/core/codex-app-server-runner.ts`, `packages/cezar/src/core/opencode-server-runner.ts`, `packages/cezar/src/core/backend-detect.ts` | One seam: every backend implements `AgentRunner`/`AgentSession` and emits both the v1 `AgentEvent` stream and the normalized v2 `UiEvent` protocol. **Read `AGENT_PROTOCOL.md` first — it is the contract a new runner must satisfy** (the event schema, per-backend mapping, golden-fixture testing, and the backend-parity requirement), with an explicit new-runner checklist. New backends slot in as one class — do not leak backend-specific types past the seam. `claude-cli` is a legacy backend id kept so old run records parse. `CEZ_DRY_RUN=1` must keep working (bundled mock, no real CLI). Tool access goes through `allowedTools`, but the zero-config default includes unrestricted `Bash` (no `bashAllowlist`) and Codex/OpenCode don't honor `allowedTools` at all — see #430.                                                                                                                                                                                                                                                                                                    |
| HTTP server & API routes                                                                                                                                                                                      | `packages/cezar/src/server/server.ts`                                                                                                                                                                                                                        | Hono app, binds to `127.0.0.1` only. A global `/api/*` request-origin guard (#426) runs before every route except `/api/v1/health`: it rejects non-loopback `Host` headers (DNS-rebinding) in local mode and cross-origin mutating requests (CSRF) in both modes — zero-config, no token, so the same-origin cockpit and the Vite dev proxy pass untouched. The loopback test is `isLoopbackHostHeader` (anchored 127.0.0.0/8, missing Host = untrusted); never match it with a `127.` string prefix. **Request validation is route MIDDLEWARE, not a `safeParse` inside the handler** — `jsonZodValidator` / `paramZodValidator` / `queryZodValidator` from `packages/cezar/src/server/validators.ts`, read from `c.req.valid('json'|'param'|'query')`. Hono records a validated shape in the route type only when validation happens as middleware, so a handler-side parse is invisible to `AppType` and the typed client would accept any body for that route. The rejection shape is unchanged: `{ error }` with 400/404/409. CORS is deliberately enabled for `/api/v1/health` only (cross-origin discovery); never widen it. SSE endpoints replay from NDJSON then stream live, deduped by `seq`.                                                                                                                                                                                                                                                                                                   |
| API request/response shapes (any new field, route or payload) | `packages/contract/src/*.ts`, then `packages/cezar/src/server/validators.ts` | **One zod definition per shape, type inferred — never a hand-written interface.** Add the schema here FIRST, then chain the route and validate through the trio; `contract-parity*.test.ts` proves the schema and the route agree in both directions, and `typed-bodies.test.ts` proves the route reached `AppType` at all. See the HTTP API section above for why a loose `app.get(…)` disappears. |
| Real-time events (live UI signals, replacing polls)                                                                                                                                                           | `.ai/specs/2026-07-23-websocket-subscriptions.md`, then `packages/cezar/src/server/ws.ts` + the `health` topic in `packages/cezar/src/server/server.ts`, and `packages/web/src/api/ws.ts`                                                                                        | Two live channels: the SSE run/event stream (`/api/v1/workspace/events`, `packages/web/src/api/global-events.tsx`) and the **WebSocket subscription bus** (`/api/v1/ws`, `ws` lib server-side, native `WebSocket` client). The bus is the pattern for any new live signal instead of a `refetchInterval`. Its whole discipline is **demand-driven subscription**: a topic's server publisher starts on the `0→1` subscriber and stops on `1→0`, and one socket per cockpit ref-counts listeners per topic. **Subscribe at the scope that matches the data's demand lifetime, always return the unsubscribe (`useEffect(() => subscribeTopic(...))`), publish only on change** — a leaked subscription is a server publisher that never stops AND a component that keeps waking for a screen the user left. Per-view signals subscribe in the view; **session-global signals subscribe ONCE at the root**, not per reader — health is the worked example: one `useHealthSubscription()` controller in `GlobalEventsProvider` subscribes after bootstrap only for local mode, while `useHealth()` is a pure cache read the ~15 readers call without touching the socket. Remote mode must open no browser WebSocket because it cannot explicitly carry reverse-proxy credentials; it uses authenticated HTTP plus SSE reconciliation. One socket per local cockpit — never `new WebSocket` for a feature; add a topic. Liveness: server ping/pong reaping + app-level beat, client watchdog + reconnect. Topics are workspace-level (single-mount, never `/api/v1/p/`) and, because the upgrade guard admits any loopback origin (WS has no CORS), must only carry data safe for any local page — read the spec's security caveat before adding one. |
| Workspace registry / per-user state (`~/.cezar/`)                                                                                                                                                             | `packages/cezar/src/paths.ts`, then `packages/cezar/src/workspace/config.ts`, `packages/cezar/src/workspace/projects.ts`, `packages/cezar/src/workspace/migrations.ts`, `packages/cezar/src/workspace/semaphore.ts`                                                                                                      | `~/.cezar/config.json` is the per-user workspace config **and** the project registry — every repo cezar has been booted in (spec `2026-07-20-multi-project-workspace`). Every path goes through `cezarHomeDir()` so `CEZ_HOME` keeps tests and containers off a real home; never re-derive `homedir()` elsewhere. Schema rules are load-bearing: every field optional with `.catch`, `.passthrough()` at every object level, per-entry salvage for `projects` (one bad row never evicts the registry), and writes only through `mergeWriteWorkspaceConfig` (read-modify-write + atomic tmp/rename, `0600`) so two processes converge. A corrupt or read-only home degrades to in-memory defaults with ONE warning — never a boot failure. Migrations are config-files-only, idempotent, additive and non-blocking; run state never migrates. `maxParallel`/`memoryLimitMb` are workspace-wide (`resources`): the per-repo keys are imported once by migration 001 and ignored by enforcement afterwards. Registration is suppressed for task worktrees and `$HOME` itself (`shouldRegisterProject`). A merge-write resolves its path ONCE and uses it for both halves — resolving it twice let a `CEZ_HOME` that changed mid-flight read one home and write another, wiping the user's registry. Two guards back that up: `assertCezarHomeWriteIsSandboxed` refuses any write into the real `~/.cezar` from a vitest process, and `packages/cezar/vitest.setup.ts` pins `CEZ_HOME` to a per-worker sandbox so no case ever runs unpinned. Every write that leaves projects behind also snapshots `config.json.bak`, which `loadWorkspaceConfig` restores from when the config is missing, empty or corrupt (a config that parses and is simply empty is the user's own state and is never overridden). | **Agent accounts** (spec `2026-07-29-agent-profiles`) live in this directory too, but in their OWN file — `~/.cezar/agent-accounts.json`, never a key in `config.json`, so a cezar that has never heard of accounts cannot drop them; `src/workspace/agent-accounts.ts` owns the store, `src/core/agent-profiles.ts` the vendor knowledge and `src/workspace/agent-profiles.ts` the resolution. |
| Project-scoped routes & contexts (`/api/v1/p/:projectId`, `/p/:projectId`)                                                                                                                                       | `packages/cezar/src/server/project-context.ts`, then `packages/cezar/src/server/server.ts`, `packages/web/src/routes.tsx`                                                                                                                                                        | One lazily built `{store, manager, dataDir, launchKey}` context per registered project, disposed on removal; a `missing` root is never instantiated (unknown id → 404, gone root → 409). Every project route is registered **once** in a chained family builder and mounted under both `/api/v1/<path>` (bound to the boot project) and `/api/v1/p/:projectId/<path>` — `route-parity.test.ts` walks the exported route manifest and asserts `/api/v1/x`, `/api/v1/p/<boot>/x` and `/api/v1/p/default/x` answer byte-identically, so a new scoped route without its alias fails the suite. `default` is the reserved boot alias and is never an allocated slug. Workspace-level routes (`/projects`, `/workspace/*`, `/fs/browse`) are single-mount and never scope-prefixed. The cockpit mirrors the split: every view lives under `/p/:projectId/`, flat legacy PAGE paths redirect to the boot project, and global settings sit outside the scope at `/settings/global`. **One versioned API surface**: the unversioned `/api/*` spelling was removed — everything answers under `/api/v1`. A chained builder is the only shape Hono can infer route types from, which is what makes `AppType` (`packages/cezar/src/server/app-type.ts`) and the typed client cover the API. **Add a route by adding a link to its family's chain, never a loose `api.get(…)` statement** — a statement reaches neither the typed client nor `AppType`; `versioned-surface.test.ts` fails on any route outside `/api/v1`, and `bc-route-inventory.test.ts` (which reads a built app's route table, not the source) requires it to be inventoried in BACKWARD_COMPATIBILITY.md §2.                                                                                                                 |
| Git / worktree logic                                                                                                                                                                                          | `packages/cezar/src/git-worktree.ts`, `packages/cezar/src/git-diff-base.ts`, `packages/cezar/src/server/git.ts`                                                                                                                                                                                                    | One worktree per task at `.ai/cezar/worktrees/<runId>`, branch `cez/<id8>` off the configured base branch. **A WORKSPACE run is one worktree per granted git REPO, not one per task** (specs `.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md` and `.ai/specs/2026-08-20-workspace-run-worktree-isolation.md`, code in `src/workspace/workspace-worktrees.ts`): several registry entries inside one checkout collapse to a single tree keyed by the resolved repo root — **never assume the registry entry count equals the worktree count**, twelve entries resolve to ten trees on this workspace — and each project is granted its own subdirectory of the shared tree rather than its real checkout. Diffs are applied back into the real checkouts on a successful settle; every other ending discards the DIRECTORIES and keeps the `cez/<id8>` BRANCHES. `src/runs/retention.ts` reclaims those directories under the same keep-last-N rule and stamps `reclaimedAt`, which is what distinguishes a reclaimed tree from a leaked one. The knowledge mount is the documented exception: it is granted at its REAL path, shared by every concurrent run, read-only. Helpers never throw (except `createWorktree`) — degradation is the caller's policy. Diffs are capped (`DIFF_CAP`). Orphaned worktrees are pruned at startup. **"Which ref anchors *this task's* diff" lives in exactly one place** — `resolveTaskDiffBase` (`git-diff-base.ts`): the merge-base against the **freshest** base ref (`origin/<base>` when the local branch is behind it — agents fetch, they never pull, and a stale local `main` is what turned an eight-line fix into `+59514 −12160`), and, when the agent checked another branch out into the worktree, that branch **as the run found it** (`<branch>@{<run start>}`), whichever of the two attributes fewer changed lines. Attributing a checked-out branch's history to this task is what produced five-figure numbers on review and QA runs (#591 fixed the Changes tab, #751 the stored `diffStat`); anchoring those runs at `HEAD` instead then reported `+0 −0` for work they really did commit. A new task-diff surface resolves through that helper and passes the run's `branch` **and** `startedAt`; `worktreeDiff`/`worktreeDiffStat` deliberately keep the whole-branch anchor and each carry a comment saying why.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GitHub integration (issues/PRs tab, draft PRs)                                                                                                                                                                | `packages/cezar/src/server/github.ts`, `packages/cezar/src/server/pr.ts`                                                                                                                                                                                                    | Must degrade gracefully: no `gh`, no remote, offline all return `{ available: false, reason }` — never an error. `gh … --json` output is zod-validated at the boundary. `GITHUB_TOKEN` is the fallback when `gh` isn't authenticated. `createDraftPr` never throws; failures map to one-line human errors. `CEZ_DRY_RUN=1` fakes the PR URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Workflows (YAML chains, steps, retries)                                                                                                                                                                       | `packages/cezar/src/workflows/types.ts`, then `packages/cezar/src/workflows/load.ts`, `packages/cezar/src/workflows/run.ts`                                                                                                                                                                | A step is agent (`prompt`/`skill`) XOR check (`command`); a file has `steps` XOR the portable `skills` shorthand — both enforced by zod refinements. `onFail.retry` may only reference an _earlier_ step (`stepsIssue`). `{{task}}` is the substitution token. `quick-task` is the built-in zero-config workflow; built-ins always come back after delete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Skills (Markdown playbooks, team repos)                                                                                                                                                                       | `packages/cezar/src/skills.ts`, `packages/cezar/src/skills-remote.ts`                                                                                                                                                                                                       | A skill is a `.md` file with optional YAML frontmatter (`name`, `description`); its body becomes the agent's extra system prompt. Discovery precedence is local-first: `.ai/cezar/skills` → `.ai/skills` → `.agents/skills` + agent mirrors → global → team repo. Missing dirs are fine; team-skill loading never blocks on the network (background cache in `~/.cache/cez/`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Runs store / state persistence                                                                                                                                                                                | `packages/cezar/src/runs/store.ts`                                                                                                                                                                                                                           | Plain files in `.ai/cezar/`, no DB: `runs.json` index (zod-validated, atomic tmp+rename, debounced save) plus one append-only NDJSON event file per run. New `RunRecord` fields must be optional so old files still parse; corrupt files degrade to fresh, never crash. A **queued** run's prompt stays editable until the scheduler picks it up (#472): `task` plus the optional `queuedMessages` stack are folded into `{{task}}` at dequeue, and that fold is read-only — never write it back to the record. The store is also the in-process event bus for SSE.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Web UI (cockpit)                                                                                                                                                                                              | `packages/web/src/app.tsx`, then `packages/web/src/routes.tsx`, `packages/web/src/api/`, and the affected component/route                                                                                                                                    | React 19 + Vite + Tailwind v4 + shadcn/ui; source lives in `packages/web/` (its own npm workspace, `@loki-labs/better-cezar-web`, with the React/Vite/Tailwind deps in ITS manifest, not the root's), build output in ignored `packages/cezar/web/dist/`. Anything the server and the cockpit BOTH speak — the v2 protocol types, the `/api/v1/p/:projectId` scope helpers, and (as it grows) the typed API client — lives in the third workspace `packages/api-client/` (`@loki-labs/better-cezar-api-client`), which must stay Node-free: no `node:*` import and no `@types/node`, because it is bundled into the browser AND imported by the Node service. Keep one global SSE connection and patch the TanStack Query cache in place; authoritative refetch happens on reconnect/visibility. Preserve light/dark/system theming, mobile safe areas, keyboard access, and unit coverage. The legacy vanilla web app was deleted in R7; when `packages/cezar/web/dist` is missing the server answers every shell route with a built-in "run `npm run build:web`" hint page (`packages/cezar/src/server/static-ui.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Agent config files (Settings → Agent config; grouped by agent, MCP as a per-agent subsection — spec 2026-07-17-agent-config-by-agent, descriptor table in `packages/web/src/routes/settings/agent-descriptors.ts`) | `packages/cezar/src/agent-config/` (`catalog.ts`, `files.ts`, `validate.ts`, `service.ts`, `seed.ts`), then `packages/cezar/src/paths.ts` and the `/api/v1/agent-config` routes in `packages/cezar/src/server/server.ts`                                                                      | Read and edit the coding agents' OWN config files (Claude/Codex/OpenCode settings, MCP, memory), raw and per-scope (spec #404). `catalog.ts` is the ONLY place vendor knowledge about config FILES lives — paths + verbatim precedence strings; keep it accurate and dated. Its sibling `src/core/agent-profiles.ts` owns the other half: the env var that relocates each agent's whole home (spec `2026-07-29-agent-profiles`). Never re-serialize a file cezar opened (byte-exact round-trip). Files are addressed by catalog id, never a path. **Writing is a local-machine capability: every `PUT /api/agent-config/:id` 409s when `capabilities().localHandoff` is false — this closes a hooks-based RCE path, do not weaken it.** The gitignored personal layer is seeded into run worktrees (`seed.ts`, guarded by `git check-ignore`).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Feature specs / design history                                                                                                                                                                                | `.ai/specs/`                                                                                                                                                                                                                                  | Numbered and dated specs are the design record — code comments cite them (`spec 006`, `#348`). Read the relevant spec before changing a feature it covers; keep new work consistent with it or update the spec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Validation

Before any commit or PR, run in order:

```bash
npm run typecheck   # tsc --noEmit (api-client + server + web)
npm test            # vitest — server + cockpit unit suites
npm run test:unit   # node:test — fast core-module coverage (packages/cezar/test/unit/)
npm run build       # tsc → dist/, vite → packages/cezar/web/dist/, then the check:pack tarball gate
npm run test:package # pack/install the release tarball and exercise the built CLI (packages/cezar/test/e2e/)
```

`npm test` and `npm run test:unit` are the fast unit gate: no server, no browser. They must stay that way. `npm run test:package` needs a completed `npm run build` (it packs the tarball).

**Run vitest through npm, never `npx vitest`.** It is a devDependency of this repo, so `npm test`
uses the installed, version-pinned binary; `npx` will happily reach past it and fetch a different
version from the registry, which is a slow, networked, silently-different test run. To narrow a run,
pass vitest's own arguments after `--`:

```bash
npm test -- packages/web/src/routes/settings   # one directory
npm test -- --testTimeout=30000 path/to/one.test.ts
npm test -- -t "the name of one test"
```

### Three environment traps that make the gates LIE

The first two were hit on 2026-08-20 (spec `.ai/specs/2026-08-20-live-run-status-line-and-timer.md`),
the third the same day (spec `.ai/specs/2026-08-20-step-and-tool-call-durations.md`). Each produces
a *plausible* failure that reads as "this suite cannot run here". None is a sandbox limitation.
**Scrub the environment before you conclude anything about a test.**

**Corrected 2026-08-20 (spec `2026-08-20-step-and-tool-call-durations.md`): the hand-written `-u`
list this block used to carry was INCOMPLETE, and an incomplete scrub is worse than none — it
looks authoritative and still leaves 11 failures behind.** It named nine variables; a run's
environment also carries `CEZ_ACCOUNT_USAGE`, `CEZ_ACCOUNT_USAGE_HOSTED`, `CEZ_BROWSE_ROOT`,
`CEZ_PUBLIC_URL`, `CEZ_PORT_STRICT` and `CEZ_ENV_PASSTHROUGH`, which leak into `health-forge`
(`accountUsage: true` where it expects `false`), `projects-api`, `agent-profile-wiring` and
`add-project-dialog`. Do not enumerate — that list will be stale again the next time a knob is
added. **Unset every `CEZ_*` except the two a run needs to report itself**, and `NODE_ENV` with
them:

```bash
scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
        | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
env -u NODE_ENV $scrub npm ci && env -u NODE_ENV $scrub npm test
```

1. **`NODE_ENV=production` makes `npm ci` install ZERO devDependencies.** cezar's own agent
   sessions run with it set, so a worktree installed under it has no vitest, no React and no
   testing-library in the tree at all. The symptom is not "missing module": it is
   **`TypeError: React.act is not a function`** out of every component test, which invites the
   conclusion that React tests are unrunnable in this environment. They are not — `unset
   NODE_ENV`, reinstall, and 174 files / 3782 tests go green. The corollary trap: reaching for
   `npx vitest` when the local binary is missing "makes it work" by fetching an unpinned vitest
   off the registry, which is exactly the silently-different run the rule above forbids. A
   missing local vitest is a signal to fix the install, never to route around it.

2. **A cockpit session exports its own knobs into the test run.** `CEZ_REMOTE=1`,
   `CEZ_OIDC_ISSUER`, `CEZ_OIDC_CLIENT_ID`, `CEZ_PROJECTS_DIR`, `CEZ_KB`, `CEZ_KB_ROOTS`,
   `CEZ_KB_WRITE_FILE`, `CEZ_TODOS_FILE` are all live in a run's environment, and the server
   suites assert on exactly those knobs — 26 unrelated failures, none of them about your change.
   Those names are **examples, not the set**: see the corrected scrub above, which unsets the
   whole `CEZ_*` prefix precisely so this list never has to be right.

3. **An absolute time budget calibrated on a different machine.** `knowledge/catalog.test.ts`
   C18 asserts `bestMs / totalMiB < 40` — a hard 40 ms/MiB, taken on the box the test was
   written on. Its comment already defends against ambient *load* (CPU time, not wall; minimum
   of three repeats), and that defence works. It cannot defend against a slower **core**. On the
   EPYC-Rome prod host this repo now runs its gates on, the same code measures **54-65 ms/MiB
   with the machine idle** (`steal=0`), so the case fails every time, on every branch. Confirmed
   the honest way on 2026-08-20: reproduced at clean `HEAD` `a6c0ba3e` in the real checkout, at
   63.7 ms/MiB, with none of the change under test present. **A red C18 on this host is a
   statement about the host, not about your diff** — and it is a red that will greet every
   future session, so do not spend an hour re-deriving it. It was deliberately left failing
   rather than widened: raising a budget to fit the slowest machine that ever runs it destroys
   the ~20% regression signal the case exists to catch. The real fix is to make the budget
   relative to a measured per-host baseline, which is a separate change and nobody's scope yet.

**The method, which generalises past all three.** "It fails on an untouched file at clean HEAD
too" feels like proof that the code is innocent and the environment is broken. It is proof of the
first half only. The same install, the same env and the same runner feed both checkouts, so a
control that fails identically **localises the fault to what they share** — it does not license
"unrunnable here". Name the shared thing and test it directly before writing an environmental
caveat into a spec, because a caveat is what the next session will obey instead of running the
gate.

### Debugging an intermittent failure — cross-file pollution is NOT a possible cause

**`isolate` is unset here, so it is vitest's default `true`: every test FILE gets its own fresh
module graph**, even inside one worker under `--no-file-parallelism`. A module-level mutation in
file A therefore **cannot** be seen by file B's own import of the same module.

Verified by experiment on 2026-08-15, not read off the docs: a deliberate top-level
`DEFAULT_PROMPT_TEMPLATES[0].text = 'POLLUTED…'` was injected into `prompt-templates.test.ts` and
paired with `new-task.test.tsx`, which asserts on that exact string. Serialized and parallel,
three runs each — **6/6 clean**. The victim never saw the mutated value.

This matters because "another test file left shared state behind" is the most attractive
hypothesis for a test that fails in the suite and passes alone, and **in this repo it is not a
mechanism that exists.** Drop that class and look at the two that do:

1. **A race inside the file's own helpers.** This is what `github.test.tsx:2020` turned out to be
   (`c27aadd8`): a retry helper treated "the DOM node vanished" as proof a click had landed, but an
   unrelated re-render removes the node too, so a click fired at that moment was a silent no-op.
   Assert the **effect** (did the value change), never a proxy for it.
2. **Genuine concurrency timing.** Failures clustered at `--maxWorkers=16` on a 16-core box, and
   this repo is often run with several agents competing for the same cores.

**Known live flake, as of 2026-08-20** — so the next session recognises it instead of bisecting
toward it: `add-project-dialog.test.tsx` > *"registers exactly the checked rows, one POST each,
and navigates to the first"* fails roughly **1 full-suite run in 4** and passes 3/3 in isolation.
It is mechanism 1 above (a navigate race in the file's own helper), not anything a caller did:
the file was untouched by the runs that surfaced it and imports nothing they changed. Unfixed —
noted here so a red on that one name is recognised, never so it is ignored.

Two method notes, both learned the hard way here:

- **Prove pollution by injecting it**, as above. A hypothesis about shared state is cheap to test
  directly and expensive to bisect toward.
- **Mind the sample size.** A sweep showing 0/4 failures at one worker count and 4/16 at another
  proves very little: at a 25% failure rate, 0-in-4 happens about a third of the time by chance.
  Prefer a mechanism trace (an invocation counter, a logged value) over a table of small-n runs —
  and note that a *signature* mismatch settles it outright, since pollution predicts a wrong
  **value** while a swallowed event predicts a missing **call**.

The UI smoke suite is a **separate** command — it boots the real app and drives it in a real
Chrome through the `agent-browser` provider (`.ai/browsers/agent-browser.md`):

```bash
npm run test:e2e    # .ai/scripts/e2e.sh → test-env-up.sh + vitest (packages/web/e2e/)
```

It boots the app on a free port with `CEZ_DRY_RUN=1` (agent CLIs mocked — no login, no
network), reuses an already-healthy instance instead of double-booting, and writes
`.ai/qa/test-env.json` so QA skills attach to the same instance. Stop it with
`.ai/scripts/test-env-down.sh`. Exit contract:

| Exit     | Marker                    | Meaning                                                                                                           |
| -------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 0        | `TEST_E2E_STATUS=passed`  | every spec passed                                                                                                 |
| 0        | `TEST_E2E_STATUS=skipped` | agent-browser could not be provisioned (no network / unsupported platform); prints a loud banner — **not** a pass |
| non-zero | `TEST_E2E_STATUS=failed`  | a spec failed, or the env could not boot                                                                          |

`CEZ_DRY_RUN=1 npm run dev` still exercises the whole cockpit offline for manual verification.

## How an agent step should spend its tool calls

Measured on run `ec6e8e06` (spec `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`):
61.5 minutes, 271 tool calls, **1.00 calls per model round trip** — it never once batched. 231 of
those calls (85%) finished in under a second and did 29 seconds of real work between them, while
costing ~23.5 minutes of round trips. The bottleneck is *asking*, not *doing*.

Read the meter before and after any change to this, rather than asserting an improvement:

```bash
cez run stats <runId>          # per-step table: calls, round trips, batch factor, model vs exec
cez run stats <runId> --json   # the same as a RunStats object
```

**Batch factor is the primary metric, deliberately over wall clock** — wall clock on a loaded box
is not trustworthy (`src/knowledge/catalog.test.ts` C18 flakes under load 5–7 on 8 cores, and
`ec6e8e06` hit exactly that), while round-trip *count* is load-independent.

The doctrine itself rides on every agent step's system prompt (`TOOL_BUDGET_DOCTRINE`,
`src/workflows/run.ts`). The "read the record" opening it asks for is shipped as a literal
(`RECORD_READ_RECIPE`, `src/workflows/types.ts`) and is worth reaching for by hand too — it turns
about fifteen opening round trips into one:

```bash
set +e
say(){ printf '\n===== %s =====\n' "$1"; }
say HANDOFF; sed -n 1,80p "$CEZ_HANDOFF_FILE"
say SPECS;   ls -1t .ai/specs 2>/dev/null | head -30
say GITLOG;  git log --oneline -15
say KB;      cez kb search "<your query>" 2>&1 | head -40
say TODOS;   cezar todo list 2>&1 | head -20
```

Three rules make a batch safe rather than merely fast, and all three are failure modes that were
reasoned through before they were hit: `set +e` (under `set -e` one missing file hides every
section after it, and the model reads the rest as success), a delimiter per section (an
undelimited blob cannot be read section by section), and a bound per section (`head -n`, `-15`,
`sed -n 1,80p` — an unbounded batch floods the context it was meant to save, which is strictly
worse than the calls it replaced).

**Sub-agent fan-out is granted asymmetrically and on purpose.** `spec` and `document` carry `Task`
because they are exploration-bound (32× and 3.3× model-time to tool-time) with independent reads;
their sub-agents stay READ-ONLY and the orchestrating step writes every word. `implement`,
`run-tests`, `commit-push` and `deploy` deliberately do NOT — concurrent writers in one worktree
corrupt each other, `run-tests` is `npm`-bound (617 of its 826 s), and git's index is one lock.
`workflows/types.test.ts` asserts that absence as hard as it asserts the presence.

## Related documents

- `AGENT_PROTOCOL.md` — the agent protocol: the runner seam, the v1 `AgentEvent` + v2 `UiEvent` streams, per-backend mapping, the golden-fixture testing contract, and the checklist for adding a new runner.
- `SDLC.md` — ticket flow, label state machine, QA gate, claim protocol.
- `CODE_REVIEW.md` — what reviewers check and how severities are assigned.
- `BACKWARD_COMPATIBILITY.md` — the public surfaces you must not break silently.
- `.ai/agentic.config.json` — machine-readable pipeline config every om-* skill reads (base branch, validation commands, labels).
