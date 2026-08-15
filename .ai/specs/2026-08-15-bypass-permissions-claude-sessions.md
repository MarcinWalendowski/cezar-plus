# Every Claude session runs in bypass permission mode

> **Status:** draft · **Date:** 2026-08-15 · **Owner decision:** yes — "all claude sessions should
> be run in bypass permission mode", and, asked whether to keep an escape hatch, "bypass always,
> drop the gate".

## TLDR

`buildClaudeArgs` passes `--permission-mode dontAsk`, or `acceptEdits` when `CEZ_APPROVAL_GATE=1`.
Both go away: every Claude session gets `--permission-mode bypassPermissions`, and
`CEZ_APPROVAL_GATE` is **removed** rather than left as an env var that silently does nothing.

While measuring the blast radius, a separate and larger fact turned up: **`--allowedTools` does not
restrict anything.** cezar's per-step tool scoping is built entirely on that flag, so the scoping
is already decorative for Claude runs — before this change, not because of it. That is recorded
here and specced out as its own follow-up, not fixed in passing.

## Problem

### 1 — the two modes we ship are both the wrong default for this product

`packages/cezar/src/core/claude-cli-runner.ts:345-357`:

```ts
'--permission-mode',
env.CEZ_APPROVAL_GATE === '1' ? 'acceptEdits' : 'dontAsk',
```

cezar's whole shape is *unattended agents working in isolated worktrees*. A run that stops to ask
is a run that is not running, and there is nobody in front of it to answer. The owner's call is to
stop pretending otherwise.

### 2 — a flag that survives a change it no longer affects is worse than no flag

`CEZ_APPROVAL_GATE=1` exists to opt back into Claude's approval UI. Under `bypassPermissions` there
is no approval UI to opt into. Leaving the variable readable-but-inert is the failure mode this
repo has already been bitten by twice (see the notes-removal entry corrected in `CHANGELOG.md` on
2026-08-15): a stale switch reads as live to the next person, who then believes they have a control
they do not have. So it is deleted from the code, the README and the tests, not defaulted.

### 3 — the measured finding: `--allowedTools` grants, it does not restrict

The doc comment above `buildClaudeArgs` says:

> `--permission-mode dontAsk` keeps headless runs non-interactive: tools in `--allowedTools`
> proceed and everything else is denied instead of prompting.

**That is false.** Measured against `claude` 2.1.224, in a scratch directory, with
`--setting-sources ""` and the inherited `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION` env unset, one
prompt asking the agent to run `echo PROBE_BASH_RAN` while only `Read` was allow-listed:

| flags | Bash ran? |
|---|---|
| `--permission-mode default --allowedTools Read` | **yes** |
| `--permission-mode dontAsk --allowedTools Read` | **yes** |
| `--permission-mode bypassPermissions --allowedTools Read` | **yes** |
| `--permission-mode dontAsk --disallowedTools Bash` | **no** — tool absent from the surface |
| `--permission-mode bypassPermissions --disallowedTools Bash` | **no** — tool absent from the surface |

The first three rows include the **negative control**: `default` mode, which is the strictest of
the three, also ran Bash. A probe whose control passes proves nothing on its own — which is why the
`--disallowedTools` rows exist. Those two are the discriminating pair, and they are what make the
table readable: `--allowedTools` is an **additive allow-rule list**, and `--disallowedTools` is what
removes a tool.

Two consequences:

- **This change does not weaken per-step scoping**, because `--allowedTools` was never enforcing it.
  `buildAllowedTools` (`claude-cli-runner.ts:389`) and the per-step `allowedTools` / `bashAllowlist`
  in `contract/src/workflows.ts:32-33` currently buy nothing on a Claude run.
- **That is a real defect, and it is not this spec's.** Fixing it means emitting `--disallowedTools`
  for the complement of the allow-list, and you cannot enumerate "everything else" — it needs a
  decision about what the deny set is. Filed as a follow-up; this spec only stops the doc comment
  from asserting the false half.

## Solution

### D1 — one value, no branch

```ts
'--permission-mode',
'bypassPermissions',
```

No env read, no ternary. The mode is a property of what cezar *is*, not of how it was started.

### D2 — `CEZ_APPROVAL_GATE` is deleted, not defaulted

Removed from `claude-cli-runner.ts`, from `packages/cezar/README.md` (three mentions: `:501-505`,
`:517`, `:696`), and from `claude-cli-runner.test.ts`. A grep for the name after this change returns
only the CHANGELOG entry recording its removal.

### D3 — the doc comment states what was measured

The docblock stops claiming `--allowedTools` denies anything. It says what the table above says,
names the follow-up, and does not editorialise about safety it cannot enforce.

### D4 — `--allowedTools` keeps being passed

It is still the mechanism by which a step's declared tools are *granted*, and removing it in the
same change would conflate two separate corrections. It stays; only the claim about it changes.

### D5 — scope is the Claude runner only

`codex-app-server-transport.ts`, `opencode-server-runner.ts` and `pi-runner.ts` have their own
permission stories and are untouched. The owner's request named Claude sessions.

## Architecture

One function, one call site:

```
buildClaudeArgs(spec, env)            claude-cli-runner.ts:345
  └─ consumed at :92 → nodeSpawn(this.bin, args) at :96
```

Nothing upstream of it knows the mode, so nothing upstream changes: `AgentRunSpec`
(`core/agent-runner.ts:37-71`) has no permission field, `configSchema` (`config.ts:36-137`) has no
permission key, the contract has no `permissionMode`, and there is no settings UI for it. This
change adds none of those. The unimplemented `.ai/specs/2026-07-17-permission-modes.md` is where a
user-facing control would go if one is ever wanted; it stays unimplemented.

## Phases

1. `buildClaudeArgs` → `bypassPermissions`; docblock rewritten to the measured facts; test updated.
2. `CEZ_APPROVAL_GATE` removed from README.
3. CHANGELOG: a ⚠️ Breaking entry (an env var that did something now does nothing *and is gone*),
   plus the `--allowedTools` finding under 🐛 Fixes as a documentation correction.

## Data Models

None. No stored state, no contract field, no config key.

## API Contracts

None. No route sees this.

## Risks

- **Every Claude run can now touch anything in its worktree, and its `--add-dir` directories,
  without asking.** That is the requested behaviour, stated plainly rather than buried. The
  containment that remains is the worktree boundary and `--add-dir`, not the permission system.
- **A reader may take "we removed the approval gate" as "we removed a working safety control".**
  Per the measurement, `acceptEdits` vs `dontAsk` was a choice between two permissive modes, and
  the tool scoping that looked like a restriction was not one. The CHANGELOG entry has to say this
  or it overstates what was lost.
- **The follow-up is easy to lose.** `--allowedTools`-is-not-a-restriction is the kind of finding
  that gets fixed in the spec and never in the code. It gets its own Notion task, not a bullet.

## Verification

Every guard names the mutation that must turn it red.

| Guard | Mutation that must turn it red |
|---|---|
| `buildClaudeArgs` emits `--permission-mode bypassPermissions` | emit `dontAsk` |
| It emits that value **with `CEZ_APPROVAL_GATE=1` in the env too** — the gate is gone, not inverted | restore the ternary |
| No file under `packages/cezar/src` mentions `CEZ_APPROVAL_GATE` | leave one mention behind |
| The docblock does not claim `--allowedTools` denies un-listed tools | restore the old sentence |

The second row is the one that matters: a test that only asserts the default value passes just as
happily against `env.CEZ_APPROVAL_GATE === '1' ? 'acceptEdits' : 'bypassPermissions'`, which is the
option the owner explicitly did **not** pick. It has to set the variable and still see
`bypassPermissions`.

Gates, in order, `npm test -- <path>` never `npx vitest`: `npm run typecheck`, `npm test`,
`npm run test:unit`, `npm run build`, `npm run test:package`. `npm test` is judged by its **exit
code**, not its pass count.

### Runtime E2E — the gate on Done

Start a real run from the cockpit on a project whose task needs a tool no step allow-lists, and
confirm from the run's own transcript that it proceeded without a permission stop. Reading the argv
out of a test is not this step: the question is whether a **spawned** session behaves, and only a
real run answers it.
