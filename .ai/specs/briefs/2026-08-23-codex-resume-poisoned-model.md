# Brief — reopening a codex run replays the POISONED model (thread/resume omits model)

**For task d2babee3. Gather-the-record step only — no spec, no code written here.**

## The problem, in this repo's own terms

`core/codex-app-server-runner.ts` `bootstrap()` builds one `overrides` object and sends
it, cleaned, to whichever RPC method applies:

```
// codex-app-server-runner.ts:374-389
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

`clean()` (`:673-679`) just strips `undefined`/`null` keys — it has no resume-awareness.
`workflows/run.ts` `modelForBackend` (`:1273-1286`) is the guard added 2026-08-22 that
drops a cross-runner model (e.g. a Claude alias like `sonnet` pinned to a codex step) so
`this.spec.model` arrives at `bootstrap()` as `undefined`:

```
// run.ts:1273-1286
private modelForBackend(runId, stepId, backend, model) {
  if (!model || !modelConflictsWithRunner(model, backend)) return model;
  this.store.appendEvent(runId, { type: 'note', stepId,
    message: `model "${model}" is not a ${backend} model — running on ${backend}'s default instead` });
  return undefined;
}
```

Called from `runAgentStep` at `run.ts:5327-5329` on **every** spawn — first turn and every
resumed/continued turn alike. Its signature (`runId, stepId, backend, model`) carries no
resume/continuation flag, so it cannot tell `bootstrap()` "this is a fresh thread, omitting
the key is safe" from "this is a resume, omitting the key is not safe."

The asymmetry: on `thread/start`, no `model` key is exactly right — codex picks its own
default and the turn works. On `thread/resume`, no `model` key means codex falls back to
whatever it persisted in `thread_settings` **when the thread was first created**. If that
thread was born while a cross-runner model was mistakenly pinned (true for threads created
before the 2026-08-22 dispatch-time guard existed, and for any future dispatch bug of the
same shape), every future resume 400s — permanently, for anyone, no matter how many times
the run is reopened. There is no backend-side reset triggered by omitting the key.

One thing worth carrying into the spec: because the poisoning is entirely in codex's own
persisted state (not in anything cezar stores), a fix that makes `thread/resume` **always**
send an explicit, cezar-chosen model automatically remediates every already-poisoned thread
on its next resume too — no backfill/migration pass is needed, as long as the explicit model
sent is one codex can actually serve.

## What the record already decided (citations)

- **Already diagnosed and already filed — not new work being discovered here.** KB note
  `notion-8d4a7d18b7e8` ("codex reported a failed turn as a done step..."), section *"Why
  'stuck in needs you' was a symptom — and a SECOND defect the fix does not reach"*,
  corrected 2026-08-23: *"A codex thread born with a rejected model can never be reopened,
  by anyone, ever... Filed as todo `52278e94`, high priority."* Companion changelog
  `notion-ac595ca5a214` (2026-08-23) confirms the same, and confirms the five affected
  production runs were worked around by starting **fresh** runs rather than reopening,
  because reopening is unfixable as-is. **Todo `52278e94-0a7a-455a-a6f7-2e30eef187a2`**
  (project `cezar`, status `todo`, priority `high`) has a title that is a word-for-word
  match of this task's title — this task IS that todo, not a duplicate to reconcile with.
- **The already-deployed fix this gap sits under.** Commit `c1ccbe79`, spec
  `.ai/specs/2026-08-22-failed-turn-reads-as-done.md` (**Status: In progress** — not yet
  marked done/implemented in its own header). What it actually shipped (KB
  `notion-9a4d1494b0bc`): a shared `codexTurnFailure()` reader so a codex `error`/`warning`
  notification and a `turn.status: "failed"` are no longer swallowed as `end_turn`, **plus**
  the `modelForBackend` dispatch-time drop described above, **plus** a refresh of the codex
  model presets to the 5.6 family (the old `gpt-5.1-codex`/`gpt-5-codex` presets were
  themselves all dead — `Model metadata not found` → 400). Nothing in that commit or spec
  touches `bootstrap()`'s `clean(overrides)` behavior on `thread/resume` — the gap is
  unaddressed by design, not by oversight; the spec's own "Measured, on the box" section
  only covers the visible-failure half.
- **cezar already has a live-catalog discovery mechanism**, but not wired to resume.
  `.ai/specs/2026-07-21-codex-latest-model-discovery.md` (no `Status:` header in the file
  itself, but confirmed implemented and in active use) specified replacing hard-coded codex
  presets with a `model/list`-backed catalog. It exists as
  `discoverCodexModels()` in `core/codex-model-catalog.ts:37` (actual RPC call at `:103`),
  wired into `core/model-presets.ts` and `GET /api/models?runner=codex` for the **UI's**
  model picker — 5-minute in-memory TTL cache, nothing persisted to `.ai/cezar/`/`~/.cezar/`.
  `CodexSession.bootstrap()` never calls this or any other model-discovery path; it is the
  natural candidate for "codex's own default" in acceptance criterion 1, but the spec still
  has to decide whether `model/list`'s response actually names a *default* model or only
  lists what's *available* — this brief could not confirm which from the record, see below.
- **No spec or code fix exists yet for this specific defect.** `grep -ril
  "thread_settings\|thread/resume" .ai/specs/` hits three files, all about the unrelated,
  already-shipped "never-persisted session id" resume defect (`.ai/specs/2026-08-22-resume-fresh-session-fallback.md`,
  `.ai/specs/2026-08-22-missing-session-resume-verification.md`, shipped in `373b1b10`) —
  that fix is about cezar resuming a session id the backend never confirmed existed, a
  different failure mode from a backend-persisted model setting. Do not conflate the two;
  the acceptance criteria's mention of `9cd43b1b` ("stuck in needs you") is the same incident
  family as `232ad6d4`/`b3b5719c` from that other fix, but this task's defect is model-level,
  not session-existence-level.
- **`modelConflictsWithRunner('sonnet', 'codex')` already returns `true`** and is also
  applied on a continuation path for the run-level model — cited in `notion-8d4a7d18b7e8` at
  `run.ts:3146` and `:3158` "with a comment naming this exact hazard." The code-mapping
  agent instead found a `continueModelIdentity`-shaped path around `run.ts:3840-3859`
  performing a similar role. **This line-number discrepancy is unresolved by this brief** —
  the file has moved between the two readings (KB note dated 2026-08-22/23 vs. this
  session's live read) or two different call sites both apply the guard. The spec step must
  re-locate the current call site(s) directly against `HEAD`, not trust either citation's
  line numbers.

## Which code is actually involved

- `core/codex-app-server-runner.ts:374-389` (`bootstrap()`, the `overrides` object and the
  `thread/start`/`thread/resume` branch) and `:673-679` (`clean()`). Also `:498-501`, a
  comment documenting the `Model metadata for <id> not found` warning that preceded all 47
  failed turns on 2026-08-22 — the existing warning-surfacing path from `c1ccbe79` that a
  fix here should reuse/extend, not replace.
- `workflows/run.ts:1273-1286` (`modelForBackend`), call site `:5327-5329` inside
  `runAgentStep` — fires identically for a first turn and a resumed turn, no
  resume/continuation flag in scope. A second model-guard call site exists further down the
  file (line number unconfirmed, see discrepancy above) for the run-level/continuation
  model.
- `core/codex-model-catalog.ts:37,103` (`discoverCodexModels`) — the existing "read codex's
  live models" mechanism, currently UI-only.
- `runs/store.ts` `stepStateSchema` (`:65-126`) — persists `sessionId` (`:92`), `backend`
  (`:95`), `model` (`:100`, the raw requested model, `undefined` when dropped),
  `modelIdentity` (`:105`), `profileId` (`:111`) per step. **No field records what codex's
  `thread_settings` actually holds server-side** for a given `threadId`, and there is no
  comparison logic anywhere between what cezar last sent and what the backend persisted —
  cezar has no way to detect a poisoned thread before spending a turn on it, confirming the
  brief's "Blast radius" paragraph.
- Claude: `core/claude-cli-runner.ts:812-828`. `--model` is pushed unconditionally whenever
  `spec.model` is truthy, independent of `--resume` vs `--session-id`. Nothing in this file
  or nearby tests documents Claude's CLI persisting a server-side per-session model the way
  codex's `thread_settings` does — `claude --resume` reads a local on-disk transcript, not a
  hosted API session with backend-owned settings — so the bug class plausibly does not apply
  to Claude, but this brief did not find a citation proving Claude has *no* server-side
  persisted-model equivalent; that still needs either a direct check against Claude CLI
  docs/behavior or a docblock note recording the reasoning, per acceptance criterion 5.
- OpenCode: `core/opencode-server-runner.ts:329-357`. `bootstrap()` always `POST /session`s
  a brand-new session — `spec.sessionId`/`spec.resume` are never read to reopen an existing
  OpenCode session — and every prompt re-sends `body.model` explicitly. **This bug class does
  not apply to OpenCode**: there is no resume at the transport level, so there is nothing to
  poison. Safe to record as a docblock note rather than needing a code change.
- Tests: `core/codex-app-server-runner.test.ts` has no `resume`/`sessionId` coverage at all
  and never asserts on the JSON-RPC params sent to `thread/start` or `thread/resume`.
  `core/missing-session-string-contract.test.ts:118` calls `thread/resume` but only to
  assert a missing-thread-id rejection string, unrelated to the model field. A negative
  control (acceptance criterion 3) has no existing scaffolding to extend from — it will need
  a new spy/mock on `rpc.request('thread/resume', ...)` asserting the `model` key's presence
  and value.

## Prior decision this would contradict, or complicate

None found. This is additive to `c1ccbe79`/`.ai/specs/2026-08-22-failed-turn-reads-as-done.md`
(closes a gap that spec's own record already names as open), not a reversal of it. The
"drop rather than substitute" decision in that spec (dropping an incompatible pinned model
rather than swapping in "the codex equivalent," because cezar's own hard-coded codex
presets were themselves found dead) should carry forward: the fix for `thread/resume` must
not reintroduce a hard-coded "codex equivalent" id — it should resolve to a live-catalog
default (`discoverCodexModels`) or the step's own already-conflict-checked model, consistent
with why that spec avoided hard-coded substitution in the first place.

## Open questions a spec will have to settle

1. **What exactly counts as "codex's own default" on resume**, and where does the spec read
   it from — `discoverCodexModels()`'s cached catalog (5-min TTL, in-memory, no persistence;
   does its response even mark one model as *the* default, or only list what's available?),
   a fresh `model/list` call at resume time (extra RPC + latency on every resume), or
   something read from codex's own config file? This brief could not confirm whether
   `model/list`'s response shape includes a default-model indicator — that needs a direct
   check against a live codex app-server response before the spec commits to a source.
2. **How to distinguish "resumed thread's first turn rejected for the model" from a genuine
   `waiting`-state question to the user**, satisfying acceptance criterion 2. The natural
   mechanism is extending `c1ccbe79`'s `codexTurnFailure()` reader (already surfaces `error`/
   `warning`/`turn.status: "failed"`) to specifically flag a model-rejection 400 on the very
   first turn after a resume as a run failure rather than a park — but the spec needs to
   define "first turn after resume" precisely (is it turn-index-since-resume, or literally
   the first RPC round-trip after `thread/resume` returns?).
3. **Test shape for the negative control** (acceptance criterion 3): a mock/spy on
   `rpc.request('thread/resume', ...)` in `core/codex-app-server-runner.test.ts` (or a new
   file) asserting an explicit `model` key is present when `spec.model` was dropped by
   `modelForBackend` — and that the assertion fails (test goes red) if the fix is reverted
   AND if only `thread/start` is covered, per the criterion's own wording. This scaffolding
   does not exist today and needs to be built new.
4. **Whether the run-level continuation path** (the second `modelConflictsWithRunner` call
   site, line number unresolved — see discrepancy above) needs the identical treatment, or
   whether fixing `bootstrap()` alone covers both step-level and run-level resume, since both
   ultimately call into the same `CodexSession.bootstrap()` / `thread/resume` RPC. The spec
   should re-derive both call sites fresh against current `HEAD` rather than trust either
   agent's line numbers, which may already be stale relative to each other.
5. **Whether Claude needs a code change or only a docblock note** (acceptance criterion 5)
   depends on confirming, not just inferring, whether `claude --resume` has any server-side
   persisted-model equivalent to codex's `thread_settings`. This brief found circumstantial
   evidence it does not (local transcript replay, `--model` always pushed explicitly
   regardless of resume) but no authoritative citation ruling it out entirely.

## What I could not find

- No confirmation of whether codex's `model/list` RPC response distinguishes a "default"
  model from the list of available ones (needed to answer open question 1).
- No spec or KB record addressing this exact `thread/resume` gap prior to the 2026-08-23
  correction inside `notion-8d4a7d18b7e8` — it is freshly diagnosed there, not elsewhere.
- No resolution of the `run.ts` line-number discrepancy (`:3146`/`:3158` per the KB note vs.
  `:3840-3859` per this session's live code read) for the run-level model-conflict guard —
  flagged above as something the spec step must re-verify directly rather than inherit.
- No test, spec, or code artifact anywhere already attempting a fix for this defect —
  confirmed via `git log --all`, `git branch -a`, and a `.ai/specs/` grep, all empty for this
  specific gap.
