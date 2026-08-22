# Brief — run-tests output-token ceiling, re-gathered after REVISE

**Task id:** 95d3c6f2-7e11-4a1d-826c-e03a5a5a168b · **Step:** 1 of 8 (Gather the record) ·
**Date:** 2026-08-22

**This is a second pass through step 1 of the same task.** A prior pass already produced a
brief (`.ai/specs/briefs/2026-08-21-run-tests-output-tokens.md`) and a spec
(`.ai/specs/2026-08-21-run-tests-reasoning-ceiling.md`, status `draft`), and `review-spec`
(step 3, on opus) returned **REVISE** with three concrete defects (handoff progress log,
2026-08-21T23:01:20Z). None of Phase 1-4 of that spec has been implemented yet — `git grep
'\-\-effort'` and `grep CLAUDE_EFFORT` across `packages/cezar/src` both return zero hits, and
`git log` shows no commit past `a5f04b0f` touching this area. **This brief does not redo the
2026-08-21 token analysis** (it stands, see "Carried forward" below) — its job is to add what
step 3 found wrong and what I verified directly in this repo's live process env, so step 2 can
revise the spec instead of re-deriving the same ground.

## The problem, in this repo's own terms (unchanged)

`run-tests` is step 5 of `spec-to-deploy` (`packages/cezar/src/workflows/types.ts:755-806`,
now `model: SPEC_TO_DEPLOY_STEP_MODEL` = `'sonnet'` since `a5f04b0f`). On the measured run
(`70f19253-cf6b-407c-92e0-96a8020a8ebb`) it spent 43,583 output tokens — ~76% of it invisible
extended-thinking spend — running 34s of gates inside a 631s step, continuing to root-cause a
failure it had already twice proven was not its own. Full detail in the 2026-08-21 brief;
carried forward verbatim below rather than re-quoted.

## What review-spec found (step 3, verdict REVISE) — verified directly, not just trusted

The handoff records three defects. I re-derived each one against the live repo rather than
taking the summary on faith:

### Defect 1 — CONFIRMED, and worse than "unverified precedence": `CLAUDE_EFFORT=high` is
### ambient in THIS session's own process env, right now

```
$ env | grep -i CLAUDE
...
CLAUDE_EFFORT=high
...
```
(This tool-call's own shell — i.e., the env this very `context` step is running in.)

`packages/cezar/src/core/agent-env.ts:221-222`:
```ts
const BACKEND_ALLOW_PREFIXES: Record<AgentBackend, readonly string[]> = {
  claude: ['ANTHROPIC_', 'CLAUDE_'],
  'claude-cli': ['ANTHROPIC_', 'CLAUDE_'],
  ...
```
`buildChildEnv`'s `allow()` (`agent-env.ts:~370`) forwards any var matching a backend's
allow-prefix that is not `looksSecret`-shaped. `CLAUDE_EFFORT` is not secret-shaped, and the
`claude` backend's prefix list includes `CLAUDE_` unconditionally (no toggle gates it, unlike
the Bedrock/Vertex prefixes a few lines below). **So a host-level `CLAUDE_EFFORT=high` rides
into every claude-backend agent spawn today, with no code path involved yet that reads or sets
`effort` deliberately.** I could not find, in this worktree, where `CLAUDE_EFFORT=high` is
itself set (`grep -rln CLAUDE_EFFORT /etc /var/lib/cezar/loki-labs/cezar` matches only
this task's own run/log/output files, never a source file, script, or systemd unit) — it is
either set by the `claude` CLI binary itself when it spawns child sessions, or by something
above cezar's own process tree. **Origin unresolved; presence and pass-through are both
confirmed.**

This means the spec's Phase 1 plan (`--effort` as a new per-step flag, `run-tests` set to
`'medium'`) is not additive against a clean baseline the way `model` was — it would be adding
an explicit `--effort medium` CLI flag on top of an environment that may already be asserting
`CLAUDE_EFFORT=high` for the same run. **Flag-vs-env precedence is the open question a spec
cannot skip**: if the CLI's `--effort` flag wins over `CLAUDE_EFFORT`, Phase 1 works as designed.
If the env wins, or if the two conflict in an undocumented way, setting `effort: 'medium'` on
`run-tests` may do nothing observable, and Phase 4's fresh measurement (the phase that actually
settles this) would misattribute a null result. I did not find CLI source available in this
worktree to settle precedence by reading it — `claude --help` and testing empirically (spawn one
`claude` process with `CLAUDE_EFFORT=high` and `--effort low` both set, read what it does) is the
concrete unblock, and it belongs to whoever writes Phase 1, before that phase is written to rely
on the flag winning.

### Defect 2 — CONFIRMED: Phase 4 step 4 contradicts run-tests' own prompt

Spec Phase 4 step 4: "Deliberately break one test... confirm the broken test is named in
`run-tests`'s own report and the step does not report green." But `run-tests`'s own prompt
(`types.ts:770-771`, unchanged by the draft spec) says: *"If any fail, FIX the code and re-run
until they pass."* A deliberately-broken test is exactly the shape of failure that instruction
tells the step to fix (revert) and then report green on — the opposite of what the
verification needs to prove. The spec as drafted cannot pass its own acceptance test without
either (a) breaking a test in a way `run-tests` cannot self-repair (e.g. an environmental
assertion, not a code bug) and saying so explicitly, or (b) adding a narrow, temporary
exception to the "FIX and re-run" instruction for the verification run only, which itself needs
to not leak into the shipped prompt.

### Defect 3 — CONFIRMED: `document` cannot host Phase 4's write-up because it runs before `deploy`

`grep -n "id: 'document'\|id: 'deploy'" types.ts` → `document` at line 859, `deploy` at line
933 — `document` is step 7 of 8, `deploy` is step 8. Spec Phase 4 step 5 says "Record the
measured number in the `document` step's normal knowledge sync (no separate action needed)."
But Phase 4's own step 1 is "trigger one `spec-to-deploy` run... and let it reach `run-tests`"
— that run's own `document` step runs immediately after ITS `run-tests`/`commit-push`, before
that same run's `deploy`, and has no way to know it is the verification run for a DIFFERENT,
earlier task's spec. The measurement can only be written up by a human or a follow-up task
after the verification run completes, not folded into that run's own automatic `document`
step. This needs an explicit follow-up todo, filed by whichever step ships Phases 1-3, not an
implicit "no separate action needed."

## Carried forward unchanged from the 2026-08-21 brief (re-confirmed available, not re-derived)

- `usage.updated` at seq 1875 of `70f19253-...ndjson`: `{"input":70,"output":43583},
  costUsd: 4.159684` — file still present (`.ai/cezar/runs/70f19253-...ndjson`, 5.1MB,
  confirmed exists this session).
- Only ~24% of the 43,583 tokens are visible (text + tool-call bodies); ~76% is invisible
  (extended thinking).
- The dominant driver was deep, correct, but out-of-scope root-causing of a confirmed
  pre-existing bug (`test:package` broker stall) — 5 probes past the point "not mine" was
  already proven.
- `npm test`'s red in that run was 2 documented failures (C18 / `add-project-dialog`), not
  the 2,152-failure baseline — **re-confirmed this session by reading the actual todo, see
  below**. Acceptance criterion (a) does not dominate; this does not fold into `c78140a8`.
- The measured run predates `a5f04b0f` (per-step model policy, run-tests→sonnet) by 82
  minutes; it ran on opus and is not a valid post-fix baseline.

## Todos read directly this session (previously only summarized secondhand)

Both now confirmed by reading `.ai/cezar/todos.json` directly (117 total todos on the real
board; the prior brief could not resolve `cezar todo list`'s `--project` requirement):

- **`c78140a8-55b0-4cc2-8d52-d2be468916fe`**, status `todo`, priority `high`: "`npm test` — a
  listed validation gate — is 2152 tests red on the prod box, independent of any change."
  Two causes: (1) ~1931 web failures, `React.act is not a function` under React 19.2.7 /
  `@testing-library/react`; (2) ~41 server failures from tests asserting "this dir is NOT a
  git repo" while cezar sets `TMPDIR` inside the repo. **Confirms the prior brief's
  conclusion**: this is a `TMPDIR`/React-version environmental issue, categorically different
  from the run's own 2-failure result, and this task genuinely stays independent of it.
- **`c895a348-4bee-4a81-89ab-a62788a6a118`**, status `todo`, priority `high`: the broker-stall
  bug this run's `run-tests` step discovered and over-diagnosed. Context field states its own
  provenance clearly: the *original* todo (`3c6a5aa7`) was filed from inside the task's own
  worktree, landed in that worktree's gitignored `.ai/cezar/todos.json`, and died with the
  worktree — re-filed by the `document` step onto the real board. This is itself a small,
  separate, already-known failure mode (worth noting, not this task's job): an agent that
  files a todo mid-task without `--project` files it somewhere that vanishes.

## What the record already decided (citations, unchanged + one addition)

- `notion-333c1a0a847b` / `notion-20c9698de5f9` (round-trip batching doctrine) and its own
  correction `notion-cc6ebabb2ab4` ("shipped and did not move the number it was written to
  move") — the draft spec already cites this as the reason it does not rely on the prompt
  clause alone. Still true; still the load-bearing precedent for why Phase 1 (the mechanical
  `--effort` lever) cannot be dropped in favor of Phase 2 (prompt wording) alone.
- `.ai/specs/2026-08-21-per-step-model-policy.md` / commit `a5f04b0f` — the `model` knob this
  spec's `effort` knob is modeled on. Re-read this session: `model` is set via
  `step.model ?? input.model` and forwarded straight into `AgentRunSpec`/`buildClaudeArgs`
  with no environment-precedence question, because no ambient `CLAUDE_MODEL`-shaped variable
  exists to conflict with it. **`effort` is not a clean analogy of `model` for exactly this
  reason** — this is the one place the two knobs' designs must diverge, and the current draft
  spec's Architecture section claims they mirror "exactly, one level simpler," which is now
  known to be incomplete.

## What I could NOT find / verify

- Where `CLAUDE_EFFORT=high` is actually set (host profile, systemd unit above cezar's own,
  or the `claude` CLI's own re-export of its running effort level). Grepping this worktree and
  `/etc` found no source of it — only this task's own run artifacts, which cannot be causal.
- Whether the claude CLI's `--effort <level>` flag overrides `CLAUDE_EFFORT` env, or vice
  versa, or whether they must agree. Not discoverable by static reading in this worktree;
  needs either CLI documentation/`--help` output or a direct empirical spawn test.
- No fresh post-`a5f04b0f`, post-fix `run-tests` measurement exists yet (Phase 4 is, correctly,
  still unimplemented) — still open, as the 2026-08-21 brief already flagged.

## Open questions step 2 (write the spec) must resolve, in addition to the 2026-08-21 brief's four

5. **Flag-vs-env precedence for effort.** Resolve empirically before committing to "`effort:
   'medium'` on `run-tests` caps the spend" as the mechanism — if `CLAUDE_EFFORT` env wins,
   the fix needs to either unset/override that var for the `run-tests` child env (a change to
   `agent-env.ts`/`buildChildEnv`, not just `buildClaudeArgs`) or the whole mechanical-lever
   premise needs to move.
6. **Phase 4 step 4's break-a-test verification needs a test shape `run-tests` cannot silently
   "fix."** Design that shape explicitly (e.g. an assertion about environment/infra that isn't
   a code bug to revert) rather than assuming any broken test will surface.
7. **Phase 4's write-up destination.** Name an explicit todo (filed at spec-authoring time, not
   deferred to "no separate action needed") for recording the verification run's measured
   number, since no step in the verification run's own chain is positioned to do it.

## Four facts that most constrain the design (supersedes the 2026-08-21 brief's four — read
## these first)

1. **`CLAUDE_EFFORT=high` is live in this very session's process env, right now, and passes
   `agent-env.ts`'s `CLAUDE_` prefix allowlist unconditionally** (`agent-env.ts:221-222`) —
   confirmed by direct `env | grep CLAUDE` in this worktree, not inferred. Any spec that adds
   a `--effort` CLI flag without addressing this ambient var risks shipping a knob that does
   nothing, and Phase 4's "fresh measurement" is the only thing that would catch that — it must
   not be treated as optional or deferred.
2. **43,583 output tokens, ~76% invisible (extended thinking), confirmed from `usage.updated`
   in the run's own `.ndjson`** — unchanged from 2026-08-21, source file still present.
3. **Both todos this task touches are read and confirmed directly**: `c78140a8` (2152-failure
   `npm test` baseline: React 19/`React.act` + `TMPDIR`-inside-repo, unrelated) genuinely does
   not apply to this task; `c895a348` (broker stall) is the real bug the over-diagnosis found,
   still open, already has acceptance criteria of its own.
4. **The draft spec (`2026-08-21-run-tests-reasoning-ceiling.md`) has three review-confirmed
   defects — an unverified env/flag precedence assumption, a self-contradicting Phase 4 step 4,
   and a Phase 4 write-up step that cannot execute where it says it will** — all three verified
   independently in this pass, not merely relayed from the review summary. Step 2 revises that
   spec; it does not need to restart from a blank page.
