# Reopening a codex run replays the model codex persisted, not the one cezar chose

**Status:** Implemented and DEPLOYED to production — QA Needed until V7 (real-box reopen of the
two named poisoned runs, `9cd43b1b` and `0f59fcd0`) is run against the deployed release.

**Deployed 2026-08-23T08:34:24Z** on `prod-host` via `cezar server-deploy
--strategy=blue-green` (the `systemd-run --user` re-exec path this box uses, per `AGENTS.md`
§"Always self-deploy"), triggered from inside this task's own cockpit session. Release
`20260823T083415Z-27b50bb3`, sha `27b50bb3` (HEAD of `origin/main`, includes this fix's merge
commit `9686b449` and the doc-closeout merge `27b50bb3`), ledger-marked `healthy: true`,
`previous` retained as `20260823T004641Z-863861d0` for `--rollback`. Verified: `GET
/api/v1/health` reports `deploy.sha` = `27b50bb3f4e776867acbcce1dc97a39c03400666`; `GET
/api/v1/ready` → 200; `cezar.service` `MainPID` replaced and running; the deployed
`dist/core/codex-resume-model.js` contains `resolveCodexResumeModel`, confirmed wired into
`dist/core/codex-app-server-runner.js`. **V7 itself was NOT run as part of this deploy** —
reopening `9cd43b1b`/`0f59fcd0` touches real production runs and is a separate QA action, not
implied by "deploy succeeded."
**Date:** 2026-08-23
**Task:** `d2babee3-22cf-4e26-bcb9-64dd531a5b37`; todo `52278e94-0a7a-455a-a6f7-2e30eef187a2`
(project `cezar`, priority high), filed by the 2026-08-23 correction to KB note
`notion-8d4a7d18b7e8`.
**Follows:** `.ai/specs/2026-08-22-failed-turn-reads-as-done.md` (commit `c1ccbe79`) — this closes
a gap that spec's own record names as open. It reverses nothing in it.
**Brief:** `.ai/specs/briefs/2026-08-23-codex-resume-poisoned-model.md`

## TLDR

`CodexAppServerRunner.bootstrap()` builds one `overrides` object and hands the same
`clean(overrides)` — `clean()` drops `undefined` keys — to either `thread/start` or
`thread/resume`. Since the 2026-08-22 dispatch guard (`modelForBackend`), a cross-runner model pin
is dropped before it reaches the runner, so `spec.model` arrives `undefined` and the `model` key
disappears from the request.

On **start** that is exactly right: codex picks its own default and the turn works. On **resume**
it is exactly wrong: an absent `model` means codex resumes the thread with whatever it wrote into
`thread_settings` when the thread was *created*. A thread born while `sonnet` was pinned carries
`sonnet` forever, and every reopen 400s. The 2026-08-22 guard is a dispatch-time guard; it cannot
reach a thread that was already born poisoned.

The fix is one asymmetry: **`thread/resume` always sends an explicit `model` that cezar has itself
checked is servable by codex; `thread/start` keeps sending none when the pin was dropped.**
Because the poison lives entirely in codex's own state and nothing of cezar's, an explicit model on
resume remediates every already-poisoned thread on its next reopen — no backfill pass, no
migration.

One narrowing, because the naive version of that sentence is false. "The run's resolved model when
it has one" cannot mean *whatever `spec.model` holds*: `runContinuation` computes
`const continueRawModel = agentModelsLocked(this.repoRoot) ? undefined : record?.model;`
(`workflows/run.ts:3842`) and hands it straight to `normalizeModelForBackend`, never to
`modelForBackend` and never to `modelConflictsWithRunner`. So a plain **Continue** on a run whose
*record* carries a foreign pin reaches `bootstrap()` with `spec.model = 'sonnet'` today, and would
reach it under a naive fix too — which would then send `model: "sonnet"` explicitly and 400 just
the same. The resolver therefore re-checks the pin itself (Solution step 1). Remediation is
complete for every already-poisoned thread whose run record does *not* also carry a foreign pin,
and for the ones that do it is completed by that re-check rather than by the record.

## Problem

### Measured, on the box (2026-08-23, `prod-host`)

Codex persists the thread's model in its own rollout files under `~/.codex/sessions/` — **not on
`session_meta`**. That first line carries `model_provider: "openai"` and no model at all; its
payload keys are `session_id`, `id`, `forked_from_id`, `parent_thread_id`, `timestamp`, `cwd`,
`originator`, `cli_version`, `source`, `thread_source`, `agent_nickname`, `agent_path`,
`model_provider`, `base_instructions`, `history_mode`, `multi_agent_version`, `context_window`,
`git`. The model lives on a separate record further down the file:

```jsonc
{"type":"event_msg","payload":{"type":"thread_settings_applied",
  "thread_settings":{"model":"gpt-5.6-sol","model_provider_id":"openai",
                     "approval_policy":"never", …}}}
```

25 of the 92 stored rollouts carry one (line 17, 17 and 23 on the three sampled), and a rollout can
carry **more than one**: `rollout-2026-08-22T18-23-02-01a02ab6-40bd-74d3-aefd-929d35c9d54c.jsonl`
has `thread_settings_applied` three times, at lines 17, 48 and 61. Those repeat records are what makes V7
provable — a successful reopen must append a *new* one naming the model cezar sent. Across those
25 rollouts:

| `thread_settings.model` | threads |
|---|---|
| `gpt-5.6-sol` | 21 |
| `sonnet` | 4 |

The four poisoned threads, with the cezar run each belongs to (read from the rollout's `cwd`,
which is that run's worktree):

| codex thread id | cezar run | created |
|---|---|---|
| `01a02afb-4310-7b72-8aaa-52cfd5066c52` | `9cd43b1b` | 2026-08-22T19:38:24Z |
| `01a02afb-77a1-7fd1-b096-0f84227462e0` | `9517b3e0` | 2026-08-22T19:38:38Z |
| `01a02afb-c775-77e3-8948-0583cfd6e809` | `0f59fcd0` | 2026-08-22T19:38:58Z |
| `01a02ad0-0710-7a50-b12e-c38f076f151a` | `28aec920` | 2026-08-22T18:51:11Z |

`9cd43b1b` and `0f59fcd0` are the two runs named in this task's own acceptance criteria — the one
that read as "stuck in needs you", and the one that correctly ended `failed` after `c1ccbe79`. The
on-disk evidence and the incident are the same threads.

What the owner saw on reopening them, verbatim:

```
· codex: Model metadata for `sonnet` not found. Defaulting to fallback metadata; this can
  degrade performance and cause issues.
✗ {"type":"error","status":400,"error":{"type":"invalid_request_error",
   "message":"The 'sonnet' model is not supported when using Codex with a ChatGPT account."}}
```

That is `c1ccbe79` **working** — the 400 is visible now instead of being swallowed as `end_turn`
— sitting on top of a second, uncovered defect. The 21 `gpt-5.6-sol` threads are the fresh runs
started 2026-08-22 ~21:20 UTC (`f73115a0`, `b34867ee`, `9e110775`, `46aebece`, `f28edef5`) plus
their children: with the pin dropped and no `model` key on `thread/start`, codex chose
`gpt-5.6-sol` and persisted it. The retry had to be five **fresh** runs rather than five reopens
for exactly this reason.

### The code

`packages/cezar/src/core/codex-app-server-runner.ts:374-389` (verified at HEAD `863861d0`):

```ts
const overrides = {
  model: this.spec.model,
  cwd: this.spec.cwd,
  sandbox: process.env.CEZ_CODEX_NETWORK === '0' ? 'workspace-write' : 'danger-full-access',
  approvalPolicy: 'never',
};
if (this.spec.resume && this.spec.sessionId) {
  await this.rpc.request('thread/resume', { threadId: this.spec.sessionId, ...clean(overrides) });
  this.threadId = this.spec.sessionId;
} else {
  const res = await this.rpc.request('thread/start', clean(overrides));
  this.threadId = threadIdOf(res) ?? this.spec.sessionId;
}
```

`clean()` (`:673-679`) strips `undefined`/`null` and has no resume-awareness. The branch above is
the **only** place in the codebase that knows whether this is a start or a resume — which is why
the fix belongs here and not upstream.

`packages/cezar/src/workflows/run.ts:1273-1286` (`modelForBackend`), called at `:5327-5329` inside
`runAgentStep`, fires identically on a first spawn and on a resumed spawn. Its signature
(`runId, stepId, backend, model`) carries no resume flag, so it cannot distinguish "omitting the
key is safe" from "omitting the key is not safe". Giving it one would be the wrong repair: the
start/resume asymmetry is a *transport* fact, visible only in `bootstrap()`.

**Line-number correction.** The brief flagged an unresolved discrepancy for the run-level
continuation guard: KB note `notion-8d4a7d18b7e8` cites `run.ts:3146`/`:3158`, a later read cites
`:3840-3859`. Both are stale. At HEAD the two `modelConflictsWithRunner` calls on the continuation
path are `run.ts:3383` (reject an explicit `opts.model` foreign to the target runner) and
`run.ts:3395` (`inheritedPinIsForeign` — clear an inherited pin on a runner switch). Neither needs
changing: both operate on the record before scheduling, and both ultimately reach the same
`CodexSession.bootstrap()`, so fixing `bootstrap()` covers the step-level and run-level resume
paths together. That answers the brief's open question 4.

### Blast radius

Any stored codex thread created while a cross-runner model was pinned is permanently
unresumable, by anyone. cezar cannot tell such a thread from a healthy one without spending a
turn on it — `runs/store.ts` `stepStateSchema` (`:65-126`) records `sessionId` (`:92`), `backend`
(`:95`), `model` (`:100`, the *requested* model, `undefined` when dropped), `modelIdentity`
(`:105`) and `profileId` (`:111`), but nothing about what codex persisted server-side, and there
is no comparison anywhere between the two. "Continue" on such a run therefore reads to the user
as *the fix did not work*.

## Solution

One rule: **a resume never inherits a model cezar did not choose.**

`thread/resume` sends an explicit `model`, resolved in this order:

1. **The step's own pin** (`spec.model`), *and only when the resolver itself confirms
   `!modelConflictsWithRunner(pinned, 'codex')`.* A pin that fails that check falls through to
   step 2 exactly as a dropped one does.
2. **The operator's configured default**, via
   `readAgentModelSettings('codex', repoRoot, env).model`. Sending the catalog's choice over an
   explicitly configured one would be cezar overriding an operator decision, which is a new bug in
   place of the old one.
3. **Codex's own current default**, taken from the live `model/list` catalog by the rule below.
4. **Nothing** — omit the key, exactly as today, and say so on the thread as a note.

### Why step 1 re-checks a pin `modelForBackend` was supposed to have cleared

Because on the path this incident actually took, nothing cleared it. `modelConflictsWithRunner`
appears in exactly three places in `run.ts` — `:1279` (inside `modelForBackend`), `:3383` and
`:3395` — and the two continuation ones sit inside `if (opts.runner !== undefined || opts.model
!== undefined)` (`:3378`), i.e. they fire only when the user changed runner or model *in the
composer*. A plain Continue satisfies neither. `runContinuation` reads `record?.model` directly
(`:3842`) and normalizes it without a conflict check.

A record carrying a foreign pin on a codex run is a **live but so far unexercised** path. It is
reachable: `store.ts:819` persists `input.model` unfiltered at creation, and the pool router
overrides the requested runner (`run.ts:4208`: `pooled?.provider ?? input.runner ??
config.defaultRunner`, cf. KB note `notion-8d4a7d18b7e8`), so a run dispatched as
`runner: 'claude', model: 'sonnet'` can land on codex with `record.model = 'sonnet'` intact — and
`runContinuation` would hand exactly that to the resolver unchecked.

**These four runs took the other route, and the spec should not claim otherwise.** Measured in
`.ai/cezar/runs.json`: `0f59fcd0`, `9517b3e0`, `9cd43b1b` and `28aec920` all have `runner: 'codex'`
with `model: null`, and every one of their steps has `model: null` too. The `sonnet` came from the
**workflow's per-step pins** — `spec-to-deploy` pins Claude aliases per step, and `step.model` was
never routed through `modelForBackend` (KB `notion-8d4a7d18b7e8`) — which `modelForBackend` now
drops, leaving `record.model` unset throughout. So step 1's re-check closes a *second, adjacent*
hole rather than the one that fired here. It costs one pure function call, and trusting
`spec.model` instead would let that hole reproduce the incident with an explicit key in place of an
absent one.

### Why step 3 is "first catalog entry" and not a default flag

`model/list` **has no default marker.** Measured against `~/.codex/models_cache.json` (codex-cli
0.147.0, fetched 2026-08-23T07:13:52Z): 7 entries, ~35 keys each, including `slug`, `display_name`,
`description`, `default_reasoning_level`, `default_reasoning_summary`, `default_verbosity`,
`visibility`, `supported_in_api`, `priority` — and no `is_default`/`default`/`recommended` field.
`discoverCodexModels`'s zod schema (`core/codex-model-catalog.ts:20-25`) parses none either. That
settles the brief's open question 1: there is nothing to read, so the spec must choose a rule and
say it is a choice.

The rule chosen is *the first non-hidden catalog entry that is also in
`KNOWN_PRESETS_BY_RUNNER.codex`, falling back to the plain first non-hidden entry when none is*.

The order on this box is `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`,
`gpt-5.4-mini`, then `codex-auto-review` (`visibility: "hide"`, filtered by
`includeHidden: false`), and their `priority` fields are `1, 2, 3, 7, 16, 23, 43` — so the RPC
order is codex's own declared ranking, not an accident of serialisation. That is the real argument
for "first entry"; the corroborating measurement is that all 21 threads cezar started with no
`model` key persisted `gpt-5.6-sol`, the top-priority entry. Neither is a contract (R2).

The `KNOWN_PRESETS_BY_RUNNER.codex` intersection is not decoration — it enforces a **standing owner
decision** that a bare "first entry" rule would silently break. That list is
`['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']`, narrowed on the owner's 2026-08-22 instruction
*"in codex use only 5.6"*, with `gpt-5.5`, `gpt-5.4` and `gpt-5.4-mini` deliberately withheld
(`core/model-presets.ts:38-59`). "First entry" agrees with that today only by luck of ordering; if
codex reprioritises `gpt-5.5` to the top, an unconstrained rule would start resuming **production**
threads on a previous generation, which is a broader breach of the instruction than the composer
picker it was written about. Intersecting binds the automatic default to the same family the
picker is bound to. The fallback exists so the whole fix cannot be disabled by a catalog rotation
that retires the 5.6 family: a servable model outside the preferred family beats no model at all,
and the Phase 1 note states which was sent either way.

### Why step 4 degrades rather than fails

When the catalog is unreachable (codex not on PATH, discovery timeout, malformed page), the
tempting alternative is to fall back to `KNOWN_PRESETS_BY_RUNNER.codex[0]`. Rejected, for the
reason `.ai/specs/2026-08-22-failed-turn-reads-as-done.md` already gave for rejecting substitution
— *"a pinned vendor id is a thing that goes stale, so substituting one trades today's wrong model
for tomorrow's"*. All three ids in that list before 2026-08-22 were dead on the production
account. A stale hard-coded id would 400 the resume exactly as the poison does, just with a
different id in the message.

Omitting the key instead means: healthy threads (21 of the 25 on this box) resume exactly as they
do today, poisoned ones fail exactly as visibly as they do today, and the note says why the
guarantee could not be honoured. No regression in either direction, and no clever guess.

This does **not** contradict step 3's use of the same list. Step 3 uses
`KNOWN_PRESETS_BY_RUNNER.codex` only as a *filter over ids the live catalog just returned*, so
every candidate is confirmed servable today and the list can only narrow the choice, never invent
one. What is rejected here is reading an id *out of* that list when discovery failed — an
unverified, provably-goes-stale id sent as if it were current. Filter, not source.

### Not in scope, and why

- **A fresh-thread fallback for a poisoned resume.** `runContinuation` already has the shape for
  it (`isMissingSessionRejection` → `missingSessionRetry`, `run.ts:4073-4082`, `:4130`), so a
  model-rejection could trigger the same one-shot restart. Deferred: an explicit model on resume
  makes the poisoned case succeed *with its conversation history intact*, and a fresh thread
  throws that history away. If Verification V1 shows codex refuses to override
  `thread_settings.model` on resume, this becomes the fallback plan — see Risk R1.
- **Recording codex's persisted model on the step** so cezar could detect a poisoned thread ahead
  of time. Unnecessary once every resume states its own model: there is nothing left to detect.

## Architecture

```
run.ts runAgentStep / runContinuation
  └─ modelForBackend(runId, stepId, backend, model)     [unchanged]
        drops a cross-runner pin → spec.model = undefined
             │
             ▼
  CodexAppServerRunner.bootstrap()                      [the only start/resume fork]
        │
        ├── thread/start   → clean(overrides)           [UNCHANGED — no model key when dropped]
        │
        └── thread/resume  → clean({ ...overrides, model: await resumeModel() })
                                        │
                                        ▼
                          resolveCodexResumeModel()      [NEW — core/codex-resume-model.ts]
                            1. pinned, iff !modelConflictsWithRunner(pinned,'codex')
                            2. readAgentModelSettings('codex', …) → normalizeModelForBackend
                                 (bare slug; the provider prefix is stripped)
                            3. first catalog entry ∩ KNOWN_PRESETS_BY_RUNNER.codex
                            4. undefined                 + a note on the thread
```

Placement: the resolver is a new module rather than a method on the runner so it is unit-testable
without spawning a child, and so `run.ts` never has to learn about resume-vs-start.

### Wiring the catalog to the runner — there is no path today

Discovery should go through the shared host-level `RunnerModelCatalog`
(`core/runner-model-catalog.ts:38`, 5-minute TTL, already the single front door for the UI's
`GET /api/models?runner=codex`) rather than a direct `discoverCodexModels()` call. **But no such
path exists**, and saying "the shared catalog" without building one would leave an implementer
falling back to a per-resume `discoverCodexModels()` — precisely the cost R3 claims is bounded.
Measured at HEAD:

- `RunnerModelCatalog` is constructed in exactly one non-test place, as a local `const` inside the
  server factory: `server/server.ts:1405`, `deps.modelCatalog ?? new RunnerModelCatalog({…})`.
  There is no module-level instance and no export of one.
- Runners are built by `core/runner-factory.ts:13-16`, whose entire signature is
  `createRunner(backend)` and whose codex arm is `return new CodexAppServerRunner();` — no options
  argument at all.

**The implementation takes option (a): a lazily-constructed module-level singleton.**
`core/runner-model-catalog.ts` gains `export function sharedRunnerModelCatalog(): RunnerModelCatalog`
— constructed on first call with the codex adapter only, memoised in a module-level variable.
`core/codex-app-server-runner.ts` calls it as the default for `resumeModel` (below), and
`server/server.ts:1405` changes its `??` fallback to that function so the host has one cache, not
two. Files touched: those two, plus `core/runner-model-catalog.test.ts` for the singleton's own
test. `createRunner`'s signature and all four of its call sites (`planner.ts:67`,
`runs/auto-name.ts:156`, `run.ts:3927`, `run.ts:5396`) are **unchanged**.

Option (b) — widen `createRunner` to an options bag and thread the catalog from `server.ts` through
`RunManager` — was rejected: it changes every one of those call sites and forces the two that have
no server context (`planner.ts`, `auto-name.ts`) to invent one, to inject a dependency only the
codex resume path reads.

The singleton's codex adapter discovers with `cwd: repoRoot` of the process, and caches per runner
rather than per cwd. That matches what `server.ts:1406-1409` already does (`cwd: bootRoot` for
every project) and is correct here because codex's `model/list` is account-scoped, not
repo-scoped; `cwd` changes only which `config.toml` codex reads, which is step 2's business and
resolved separately. With this in place the cost is one extra app-server spawn per host per 5
minutes, paid only on resume and only when steps 1–2 came up empty — never on `thread/start`,
which is the hot path.

## Data models

No change to `runs.json`. `stepStateSchema` is untouched: `model` keeps meaning "what this step's
latest attempt *asked for*" (spec `2026-08-22-per-step-model-display`), which stays `undefined`
when the pin was dropped. The model this fix synthesises is a transport-level detail of one
`thread/resume` request, not a step fact, and writing it into `model` would make the step rail
claim the user pinned something they did not.

New module surface (`packages/cezar/src/core/codex-resume-model.ts`):

```ts
export interface CodexResumeModelInput {
  /**
   * `spec.model`. NOT assumed to have been conflict-checked: the `runContinuation` path reaches
   * `bootstrap()` with an unchecked `record.model` (`run.ts:3842`), so the resolver re-checks it
   * with `modelConflictsWithRunner(pinned, 'codex')` and falls through when it conflicts.
   */
  pinned?: string;
  /** Live catalog reader; `[]` or a throw both mean "unavailable". */
  discover: () => Promise<readonly ModelOption[]>;
  /** Passed to `readAgentModelSettings`; the resumed session's repo root. */
  repoRoot: string;
  /** Passed to `readAgentModelSettings`; defaults to `process.env`. Injected in tests. */
  env?: NodeJS.ProcessEnv;
}

export interface CodexResumeModel {
  model?: string;
  source: 'pinned' | 'config' | 'catalog' | 'unavailable';
}

export function resolveCodexResumeModel(input: CodexResumeModelInput): Promise<CodexResumeModel>;
```

**Step 2 reuses `readAgentModelSettings`, it does not re-derive it.** An earlier draft of this spec
hand-rolled a `configuredCodexModel(codexHome)` that matched `^\s*model\s*=\s*["']([^"']+)["']`
over the lines before the first `[section]` header, on the reasoning that a resume default is not
worth a TOML dependency. That was wrong on the facts: cezar already has this reader, it is already
a real parser, and it is strictly better.

`readAgentModelSettings('codex', repoRoot, env)` (`agent-config/models.ts:22` →
`agent-config/model-settings/codex.ts` → `model-settings/shared.ts`) parses with **`smol-toml`**
(`shared.ts:1`), reads **both** codex config files in the declared `modelPriority` order
(`shared.ts:73-74`) — project `.codex/config.toml` (`modelPriority: 2`) outranking user
`~/.codex/config.toml` (`modelPriority: 1`), per `agent-config/catalog.ts:196-214` — resolves the
user's home from the passed `env` rather than the process's. The hand-rolled regex would have
ignored the project-level file entirely and mis-resolved the home under test.

**But its output is not a wire model, and handing it through verbatim would reintroduce this very
400.** `codexModelSettingsStrategy` returns `` `${provider}/${model}` `` whenever codex's
`model_provider` is set to anything other than `openai` (`model-settings/codex.ts:16`) — a
supported, tested configuration: `agent-config/models.test.ts:69` writes
`model = "deepseek-chat"` / `model_provider = "deepseek"` and asserts the reader yields
`deepseek/deepseek-chat`. `thread/resume`'s `model` param takes a **bare slug**, so on such a host
step 2 would send `model: "deepseek/deepseek-chat"` and earn `Model metadata for … not found` →
400, the same failure class in a new costume. Steps 1 and 3 both already arrive bare (`spec.model`
is `toBackendModel`'s output; the catalog pick is a `ModelOption.id` slug), so step 2 has to be
normalised to the same wire form rather than trusted:

```ts
let configured: string | undefined;
try {
  const settings = await readAgentModelSettings('codex', repoRoot, env);
  configured = settings.model
    ? normalizeModelForBackend('codex', settings.model, { configuredProvider: settings.provider })
        ?.backendModel
    : undefined;
} catch {
  // Unreadable config, malformed TOML, or a pairing `resolveModelIdentity` rejects
  // (`ModelIdentityError`) — all three fall through to step 3 rather than failing the resume.
  configured = undefined;
}
```

`normalizeModelForBackend('codex', 'deepseek/deepseek-chat', { configuredProvider: 'deepseek' })`
returns `backendModel: 'deepseek-chat'`: `BACKEND_MODEL_MAP.codex` is `{ defaultProvider: 'openai' }`
with no `allowExplicitProvider`, so `toBackendModel` strips the prefix
(`core/model-identity.ts:184-195`). Passing `configuredProvider` is **not** optional — without it
the identical call *throws* `ModelIdentityError` (`:155-165`), because `deepseek !== openai` on a
backend that does not advertise explicit providers. The `try` plays the role
`run.ts:147-152`'s `configuredModelProvider` plays with `.catch(() => undefined)`. This also
deletes a risk the earlier draft had to carry: with a real TOML parser there is no section-scoping
hazard to defend against.

## API contracts

`thread/resume` request params, before and after, for a step whose `sonnet` pin was dropped:

```jsonc
// today — codex falls back to thread_settings.model = "sonnet" → 400, forever
{ "threadId": "01a02afb-4310-…", "cwd": "/…/worktrees/9cd43b1b-…",
  "sandbox": "danger-full-access", "approvalPolicy": "never" }

// after — codex is told which model to use, overriding what it persisted
{ "threadId": "01a02afb-4310-…", "cwd": "/…/worktrees/9cd43b1b-…",
  "sandbox": "danger-full-access", "approvalPolicy": "never",
  "model": "gpt-5.6-sol" }
```

`thread/start` params are **byte-identical to today** in every case. That is the regression
control (acceptance criterion 4), not a side effect.

`CodexRunnerOptions` (`core/codex-app-server-runner.ts:39`) gains one optional member:

```ts
/** Resolves the model a `thread/resume` must state explicitly. Injected in tests; defaults to
 *  `resolveCodexResumeModel` over `sharedRunnerModelCatalog().get('codex')` (see Architecture →
 *  "Wiring the catalog to the runner"). Never consulted on `thread/start`. */
resumeModel?: (pinned: string | undefined, cwd: string) => Promise<CodexResumeModel>;
```

Injection rather than reaching for the singleton directly *from the call site*, because the
singleton is host-level with a 5-minute TTL and would bleed state between tests. The singleton is
the default's implementation, not the test path — which is also what makes V4 executable without a
"disable Phase 1" toggle: a test injects a `resumeModel` that resolves `source: 'unavailable'`.

## Phases

Each phase is independently shippable and independently green.

### Phase 1 — `thread/resume` states its model

`core/codex-resume-model.ts` (new) with `resolveCodexResumeModel` as specified above, plus
`sharedRunnerModelCatalog()` in `core/runner-model-catalog.ts` and the `server.ts:1405` fallback
swap that gives the runner a discovery path at all. `bootstrap()` splits its two branches:
`thread/start` keeps `clean(overrides)`
untouched; `thread/resume` sends `clean({ ...overrides, model })` from the resolver. The runner
emits a `note` on the thread stating the outcome — one of:

- `resuming on <model> (pinned)` — source `pinned`
- `resuming on <model> (codex config default)` — source `config`
- `resuming on <model> (codex's current default)` — source `catalog`
- `could not read codex's model catalog — resuming on whatever model this thread was created
  with, which may be one codex cannot serve` — source `unavailable`

The last string is the honest one and is load-bearing: it is the only case where the guarantee is
not delivered, and a run that fails afterwards must have said so beforehand. Same reasoning as
`modelForBackend`'s own drop note — *"a model pin silently ignored is its own small lie"*.

A docblock on the resume branch records the mechanism (codex persists `thread_settings.model`;
an absent key means inherit, not default) so the next reader cannot re-collapse the two branches
back into one `clean(overrides)`.

Unit tests, all against the existing mock app-server fixture
(`core/__fixtures__/codex/mock-codex-app-server.mjs`), extended per Phase 1b:

- resume with a dropped pin → the recorded `thread/resume` params contain `model` (**the negative
  control**, see below);
- resume with a live pin → `model` is the pin, untouched;
- start with a dropped pin → the recorded `thread/start` params contain **no** `model` key (**the
  regression control**);
- catalog throws → resume omits `model` *and* the `unavailable` note is emitted.

### Phase 1b — the fixture learns about persisted thread settings

`mock-codex-app-server.mjs` today accepts `thread/resume` and answers `{ thread: { id } }` without
looking at `model` (`:60-65`). It gains:

- `MOCK_CODEX_PERSISTED_MODEL=<id>` — the model this mock "created the thread with". On
  `thread/resume`, the effective model is `msg.params.model ?? MOCK_CODEX_PERSISTED_MODEL`. This
  *is* the codex behaviour being fixed, reproduced in the mock rather than described in prose.
- When the effective model is one the mock cannot serve (any id not matching `/^gpt-/`), the
  first `turn/start` replies with the real captured rejection shape already scripted at `:98-108`
  — `warning` (`Model metadata for \`<id>\` not found…`), then `error` with the verbatim 400, then
  `turn/completed` carrying `status: "failed"`. Reusing that exact shape keeps one description of
  the provider's wire format in the fixture instead of two.
- The params of every `thread/start` / `thread/resume` are echoed to stderr as
  `MOCK_RPC <method> <json>`, so a test can assert on the *request* and not only on the outcome.

This phase is what makes the negative control real. **Reverting Phase 1 must turn it red**, and
asserting only on `thread/start` must not satisfy it: the test resumes a thread whose persisted
settings name `sonnet`, and both halves are checked — the request carries `model`, *and* the turn
succeeds instead of producing the 400. With Phase 1 reverted the `model` key is absent, the mock
falls back to `sonnet`, and the assertion fails on the request line before it ever reaches the
turn.

### Phase 2 — a rejected resume fails the run, and names the model cezar sent

Analysis of the current code says criterion 2 is **already structurally satisfied** by `c1ccbe79`,
on both resume paths, and that it is simply untested there. In `run.ts` the `error` handler
(`:5194-5203` in `runAgentStep`, `:3681-3685` in `runContinuation`) sets `sessionError`,
interrupts the session and returns; the `if (sessionError) return;` line immediately below then
suppresses every later event **including `turn-end`**, which is the only thing that can park a run
at `waiting` (`:5290-5291`, `:3782-3783`). `runContinuation` then rethrows at `:3996` and lands in
the `else` branch at `:4088-4098` → run `failed`, verbatim message. The "stuck in needs you" the
owner saw on `9cd43b1b` predates `c1ccbe79`.

So this phase adds no park-suppression logic. It adds:

1. **Regression tests that prove it on the resume path**, which no existing test covers — the
   codex runner's own tests never exercise `resume`/`sessionId` at all, and
   `core/missing-session-string-contract.test.ts:118` touches `thread/resume` only to assert a
   missing-thread-id rejection string. Two tests: a resumed session whose first turn returns the
   400 ends the run `failed` with the provider's message verbatim, and the run's status is never
   `waiting` at any point in the sequence.
2. **The model in the failure message.** When a resumed thread's first turn fails, the note that
   Phase 1 emitted already states what cezar sent; the step error should be readable next to it
   without cross-referencing. The runner appends ` (resume sent model: <id>)` to the emitted error
   when the failure is the first turn of a resumed thread and the message names a model. "First
   turn of a resumed thread" is defined as *before this session has seen its first `turn/completed`
   or `turn/failed`* — a boolean set in `bootstrap()`'s resume branch and cleared at the first turn
   boundary. That is the brief's open question 2, settled: it is turn-boundary state on the
   session, not an RPC-round-trip count, because that is the granularity every other lifecycle
   decision in this file already uses.

### Phase 3 — the same question, answered for claude and opencode

**OpenCode: does not apply, proven.** `core/opencode-server-runner.ts:329-357` — `bootstrap()`
unconditionally issues `POST /session` and never reads `spec.sessionId` or `spec.resume`. There is
no transport-level resume, so there is no persisted per-session model to inherit, and every
`prompt()` re-sends `body.model` explicitly (`:355-357`). `isMissingSessionRejection` already
records the same fact for the same reason (`core/agent-runner.ts:126-128`). Deliverable: a
docblock on `opencode-server-runner.ts`'s `bootstrap()` stating it, cross-referencing this spec.

**Claude: measure it, then decide.** `core/claude-cli-runner.ts:812-828` pushes `--model`
unconditionally whenever `spec.model` is truthy, independent of `--resume` vs `--session-id`, so
claude is only exposed in the same narrow window codex is: when the pin was *dropped*. Evidence so
far is circumstantial in both directions — `claude --resume` replays a local on-disk transcript
rather than a hosted session with backend-owned settings, and a sampled transcript under
`~/.claude/projects/` has no session-level model field (its first record's keys are `aiTitle`,
`sessionId`, `type`; `model` appears only on individual assistant records) — but nothing found
rules out the CLI restoring the last record's model when no `--model` is given. There is also no
claude adapter on `RunnerModelCatalog` (`server/server.ts:1406-1409` registers `codex` and
`opencode` only), so claude has no discovery source to resolve a default from even if it needed
one.

Deliverable: a live contract test beside `core/missing-session-string-contract.test.ts`, following
that file's own pattern (skip when the CLI is absent from PATH). It creates a session pinned to
one model, resumes it with **no** `--model`, and asserts which model answers. Then:

- if claude picks its configured default → a docblock recording the measurement, the date, and
  the CLI version, and no code change;
- if claude inherits the transcript's model → the same explicit-model treatment as Phase 1, with
  the default resolved from claude's own configured default rather than a catalog.

Recording the measurement rather than the inference is the point. This spec does not guess the
answer, and neither should the docblock.

**Pi: same exposure, deferred, and named so.** `buildPiArgs` (`core/pi-runner.ts:316-322`) has the
identical shape claude does — `--session` on resume, `--model` pushed only `if (spec.model)` — so
it carries the same narrow exposure whenever a pin is dropped. The task asks about claude and
opencode only, so pi is **out of scope for this spec**; this phase closes three of the four
runners, not the runner surface. Filed as a follow-up rather than left implied.

## Risks

**R1 — codex may not honour `model` on `thread/resume` at all.** The whole fix assumes the
parameter overrides `thread_settings.model` rather than being ignored or rejected on an existing
thread. cezar sends it today on `thread/start` and it demonstrably takes effect (that is how all
25 threads got their persisted value), and the resume RPC takes the same overrides shape — but
this is not verified. **V1 below is a blocking gate: it runs before any code is written**, against
a real poisoned thread on the box. If it fails, Phase 1 is void and the fallback is the
fresh-thread restart described under "Not in scope".

**R2 — the catalog's first entry stops being codex's default, or drifts off the 5.6 family.** Two
distinct drifts, with different severities.

*Ordering drift.* `priority` (`1, 2, 3, 7, 16, 23, 43`) and 21/21 agreement are evidence, not a
contract. Consequence: resumes run on a real, servable model that is not the one codex would have
chosen, stated on the thread by the Phase 1 note. Detectable from the note, correctable in one
line. Accepted.

*Family drift.* The more consequential one, and the reason step 3 intersects with
`KNOWN_PRESETS_BY_RUNNER.codex`: an unconstrained "first entry" would silently start resuming
production threads on `gpt-5.5` or older the moment codex reprioritises, breaching the owner's
standing *"in codex use only 5.6"* (2026-08-22) on a path nobody is watching. The intersection
converts that from a silent breach into the explicit fallback case, which the note also states.
Residual risk: if codex retires the whole 5.6 family, the fallback fires and the same silent-
generation-drop returns. Accepted deliberately — a servable model beats no model, and the
`KNOWN_PRESETS_BY_RUNNER.codex` list is already flagged in its own docblock as the thing that goes
stale and needs refreshing from discovery.

**R3 — one extra app-server spawn on resume.** Bounded by `RunnerModelCatalog`'s 5-minute
host-level TTL — *which is only true once `sharedRunnerModelCatalog()` exists*; without the wiring
described under Architecture the fallback is a fresh `discoverCodexModels()` per resume and this
risk is unbounded. Paid only when steps 1–2 came up empty. Never on `thread/start`. If discovery is
slow, `discoverCodexModels` already caps itself at `DEFAULT_DISCOVERY_TIMEOUT_MS` = 5s
(`core/codex-model-catalog.ts:32`) and a timeout degrades to case 4, not to a hang.

**R4 — a run record's foreign pin reaches the resume as an explicit model.** The failure the naive
fix would have introduced: `runContinuation` never conflict-checks `record.model` (`run.ts:3842`),
so a `sonnet`-pinned run landed on codex by the pool router would send `model: "sonnet"` and 400
identically. Mitigated by the step-1 re-check (Solution), and covered by a unit test that passes a
conflicting `pinned` and asserts the resolver falls through to config/catalog rather than
returning it.

**R5 — the fixture drifts from the real wire shape.** Phase 1b's mock reproduces codex behaviour
from a 2026-08-22 capture. If codex changes it, the unit tests stay green while production breaks.
Mitigated by V1 and V2 being live probes against the real CLI, not mock tests, and by reusing the
one already-captured rejection shape rather than writing a second.

## Verification

Concrete and executable. V1 gates the implementation; V2–V6 gate the merge; V7 gates "done".

**V1 (blocking, before writing code) — does an explicit model override the persisted one?**
On `prod-host`, drive the real app-server exactly as `missing-session-string-contract.test.ts`
does, against a known poisoned thread — `01a02ad0-0710-7a50-b12e-c38f076f151a` (run `28aec920`,
`thread_settings.model = "sonnet"`; it is the oldest of the four and not one of the two named in
the acceptance criteria, so the two incident threads stay untouched as evidence):

```
initialize
thread/resume { threadId: 01a02ad0-…, cwd: <scratch>, sandbox: danger-full-access,
                approvalPolicy: never, model: "gpt-5.6-sol" }
turn/start    { input: [{ type: 'text', text: 'reply with the single word ok' }] }
```

Pass = `turn/completed` with `status: "completed"`, no `warning` naming `sonnet`, no 400.
Fail = the rejection reproduces → stop, and re-plan Phase 1 as the fresh-thread fallback.
Re-run the identical sequence **without** the `model` key as the paired control; it must produce
the 400. Capture both transcripts into the run's handoff.

**V2 — the negative control goes red on revert.** `npm test` green with Phase 1 + 1b, then
`git stash` the `bootstrap()` change alone and confirm the resume test fails on the *request*
assertion (`thread/resume` params contain no `model`). Quote both outputs. A test that stays green
with the fix reverted does not satisfy acceptance criterion 3 and blocks the merge.

**V3 — the regression control.** In the same run, the `thread/start` test asserts the params are
byte-identical to today's, with **no** `model` key when the pin was dropped. Assert on the recorded
request object, not on the turn outcome — a passing turn does not prove the key was absent.

**V4 — resume failure is a run failure, never a park.** There is no toggle that "disables Phase 1",
so this test uses the mechanism Phase 1 itself provides: inject
`resumeModel: async () => ({ source: 'unavailable' })` (`CodexRunnerOptions`), which reaches the
exact degraded path of Solution case 4 — no model, so the resume omits the key — without
constructing the resolver at all. The mock then falls back to `MOCK_CODEX_PERSISTED_MODEL=sonnet` and rejects the
first turn. Drive a full continuation through `RunManager`: assert the run ends `failed`,
that `run.error` contains the verbatim `is not supported when using Codex with a ChatGPT account`,
and that no `waiting` status was ever written for that run (assert over the recorded status
transitions, not just the terminal state).

**V5 — the resolver's branches.** Unit tests on `resolveCodexResumeModel`: a servable pinned model
wins over config; **a *conflicting* pinned model (`'sonnet'`) is rejected and falls through to
config — R4's control**; config wins over catalog; the catalog pick is the first non-hidden entry
that is in `KNOWN_PRESETS_BY_RUNNER.codex` (feed a reordered catalog with `gpt-5.5` first and
assert `gpt-5.6-sol`, not `gpt-5.5`); the plain-first fallback when the catalog contains no 5.6
entry at all; `source: 'unavailable'` with no model when `discover()` throws *and* when it returns
`[]`. Step 2 needs no reader tests of its own — `agent-config/models.test.ts` already covers
project/local precedence (`:14`), malformed-file fallback (`:39`) and codex specifically
(`:69`, `:85`); assert only two things about step 2's own wrapper: that a throwing
`readAgentModelSettings` degrades to catalog rather than rejecting, and — the wire-form control —
that a config naming a non-`openai` `model_provider` (`model = "deepseek-chat"`,
`model_provider = "deepseek"`, the fixture `models.test.ts:69` already uses) resolves to the **bare
`deepseek-chat`**, never `deepseek/deepseek-chat`. Assert on the resolved string, and add the
sibling case where the pairing is unresolvable (`ModelIdentityError`) so it falls through to
catalog instead of failing the resume.

**V6 — gates.** `npm run typecheck`, `npm run lint`, `npm test` all green, quoted.

**V7 — real remediation on the box (the QA gate; this is not Done until it passes).** After deploy,
reopen both poisoned runs. **They are different cases and must not be given the same expected
result** — an earlier draft of this section asked for one that neither can satisfy.

Measured at HEAD, over `.ai/cezar/runs/<runId>.ndjson` (append-only; every record carries a
monotonic `seq`, max `100` and `89` respectively):

| run | thread | `grep -c 'not supported when using Codex'` | shape of the failure |
|---|---|---|---|
| `0f59fcd0` | `01a02afb-c775-77e3-8948-0583cfd6e809` | **8** (lines 84, 86, 87, 88, 96, 98, 99, 100) | the visible 400, post-`c1ccbe79` |
| `9cd43b1b` | `01a02afb-4310-7b72-8aaa-52cfd5066c52` | **0** (and `grep -c sonnet` = 0) | the *silent* park, pre-`c1ccbe79` |

`9cd43b1b`'s last continuation ran at 19:46, before `c1ccbe79` shipped, so it has no pre-fix 400
to compare against: it ended `turn-end` → `done` → `session parked after 15m of inactivity` →
`run finished`. Demanding a non-zero pre-fix count from it is unsatisfiable.

*Procedure, for each run:* record `max(seq)` from its `.ndjson` **before** pressing Continue, then
evaluate every assertion below only over records whose `seq` is greater than that watermark. The
log is append-only, so a whole-file `grep -c` on `0f59fcd0` can never reach `0` — its 8 historical
hits are permanent evidence and must stay there.

- **`0f59fcd0` — the before/after case.** Pre-fix: 8 hits. Post-reopen, among `seq > watermark`:
  **0** hits of `not supported when using Codex`, the Phase 1 note naming the model cezar sent is
  present, and the turn produces real output. This is the same before/after shape
  `.ai/specs/2026-08-22-failed-turn-reads-as-done.md` used to prove its own fix (47 of 57 failed
  turns before, 0 after).
- **`9cd43b1b` — the silent-park case.** There is no 400 to make disappear. Pass = among
  `seq > watermark`: no 400, the Phase 1 note is present, and the turn produces **real output and
  non-zero tokens** rather than the empty `turn-end` → park that made it read as "stuck in needs
  you". Zero-token success is the failure mode this case is checking for, so assert the tokens.

*Confirm codex's own state actually changed*, for both — **with a watermark, exactly as the
`.ndjson` assertions above use one**, because "a second `thread_settings_applied` record" is
already true before the reopen and so could never fail. Measured 2026-08-23:
`rollout-…-01a02afb-c775-…jsonl` has `thread_settings_applied` at lines **10 and 15**, and
`rollout-…-01a02ad0-…jsonl` at lines **10 and 16**; both records in each say `sonnet`. So: record
the **count** of `thread_settings_applied` records in the thread's rollout under
`~/.codex/sessions/` *before* pressing Continue, and pass only when (a) the count has increased and
(b) the **newest** such record carries the model cezar sent rather than `sonnet`. That is the whole
point of the check — the rollout is where the poison lives, and a fresh `thread_settings_applied`
naming cezar's model is codex saying it accepted the override. Reading `session_meta` here proves
nothing; it carries no model.

Until both runs have passed, this ships as **QA Needed**, not Done.

## What I could not verify

- **That `model` on `thread/resume` overrides `thread_settings.model`.** No documentation found
  for the codex app-server's `thread/resume` parameter semantics, and no capture of it in the
  repo or the corpus. This is R1 and V1, and it is why V1 blocks rather than merely confirms.
- **Whether `claude --resume` restores a model when `--model` is absent.** Circumstantial evidence
  both ways is recorded in Phase 3; the phase measures it rather than assuming.
- **Whether codex's catalog order is defined to put the default first.** Measured agreement
  (21/21) is not a contract; recorded as R2 rather than asserted as fact.
