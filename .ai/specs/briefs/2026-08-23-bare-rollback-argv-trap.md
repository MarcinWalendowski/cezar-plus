Brief — `cezar server-deploy --rollback` (bare) dies in argv parsing before it ever reaches deploy code

**Task id:** e4faf470-0b38-42ec-8335-5c9b6da5c8c7
**Step:** 1/8 — Gather the record (this document is a brief, not a spec; no code written here)

## Problem, in this repository's own terms

`cezar server-deploy --rollback` (no `=value`) exits with `Option '--rollback <value>' argument missing`
and never reaches `releaseDeployCommand`. This is the emergency path — the one command an operator
types under pressure — and it is the one that does not work. It fails closed (nothing on the box is
touched before the parse error), but it fails.

Root cause, confirmed by direct experiment against `node:util`'s `parseArgs` (not just reading the
option table): `rollback` is declared `{ type: 'string' }`
(`packages/cezar/src/index.ts:327`), and node's strict `parseArgs` treats a `string`-type option's
value as *required*, never optional — there is no built-in "optional value" mode. I ran this against
Node's actual `parseArgs` (not assumed from docs) to pin down every failing shape:

```
--rollback (alone, end of argv)         → "Option '--rollback <value>' argument missing"
--rollback --follow (nothing after it)  → "Option '--rollback' argument is ambiguous." (node explicitly
                                            refuses to swallow the next '--flag' as the value — it does
                                            NOT silently consume '--follow' as the rollback target)
--rollback abc123 (space-separated)     → WORKS TODAY: values.rollback === 'abc123'
--rollback= (empty, explicit)           → WORKS TODAY: values.rollback === ''
--rollback=<id>                         → WORKS TODAY: values.rollback === '<id>'
```

So the only broken shapes are "`--rollback` with nothing after it" and "`--rollback` immediately
followed by another `--flag`" — both of which are exactly "an operator typed the bare emergency flag."
`--rollback abc123` (space, no `=`) already works and must keep working.

The help text at `index.ts:118` advertises `--rollback[=<id>]` (optional-value syntax) and
`release-cli.ts:34`'s own doc comment says `''` = roll back to previous — the code's own contract
says bare `--rollback` should mean "roll back to the previous release," but the argv layer in front
of it never lets that value reach `releaseDeployCommand`.

## What the record already decided (citations)

- **This exact defect is already named and open in the corpus, found by this same task family.**
  `AGENTS.md` (§ "Shipping cezar itself," the `prod-host` correction block) states directly:
  *"Two flag traps: bare `--rollback` dies in argv parsing, use `--rollback=` (todo `f97ddd39`) ...
  `f97ddd39` (the bare `--rollback` argv trap) is still open."* — the sibling trap, `6497f002`
  (rollback never probed readiness), is explicitly marked fixed in the same sentence. `f97ddd39`
  itself was not found as a literal string anywhere in the KB or `notion-export/` (`grep -rl
  f97ddd39` returned nothing, `cez kb search "f97ddd39"` returned only briefs/specs that happen to
  quote this AGENTS.md passage) — it appears to be a todo-id reference with no separately materialized
  todo file in this corpus snapshot. Treat the AGENTS.md line itself as the authoritative record of
  the defect; do not expect a standalone todo document to exist.
- **`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`** is the parent spec that introduced
  `--rollback` as a CLI flag at all (P1–P5, blue-green strategy). It is QA-reopened for an unrelated
  reason (criterion 1, mid-run deploy continuity on blue-green cutover) — not related to this argv
  bug — so this fix does not need to touch that spec's own open items.
- **`specs-d65b1e0f0e15` / `.ai/specs/2026-08-22-rollback-readiness-gate.md`** — the sibling bug
  (`6497f002`): an explicit `--rollback` used to report success without probing `/api/v1/ready`.
  **Already fixed and merged** (commit `2f91de4b`, merged `c31af208`), IMPLEMENTED/QA-Needed pending
  its own runtime E2E. Its fix lives in `deploy-strategy.ts`'s `runExplicitRollback` — downstream of
  argv parsing, so it is unaffected by (and does not fix) the bug in this brief. Good precedent for
  where this task's own status-log discipline should go (a "Status log" section, `CORRECTED`/`SUPERSEDED`
  lead-ins for anything this brief's spec later revises).
- **`.ai/specs/2026-08-22-server-deploy-dry-run-flag.md` / commit `18707bf1`** — the most recent
  precedent for "add/fix a `server-deploy` flag correctly": it registered `--dry-run` in `parseArgs`,
  threaded it through both strategies, and **added a subprocess-level CLI-wiring test**
  (`server-deploy-cli-wiring.test.ts`) whose whole reason to exist is stated in its own comment:
  *"a unit test on `releaseDeployCommand` never touches `parseArgs` at all"* — a unit test on the
  deploy logic cannot prove the flag is reachable from the real CLI entry point. This is the exact
  test shape acceptance criterion 2 ("a test covers the bare flag, not just `--rollback=<id>`")
  needs: existing coverage (`release-cli.test.ts:340-347`, `deploy-strategy.test.ts:183-238`) all
  calls `releaseDeployCommand({ rollback: '' })` directly — bypassing `parseArgs` entirely — so none
  of it would have caught this bug and none of it will prove the fix.

## Code actually involved (current HEAD; worktree `e4faf470`, branch `cez/e4faf470`)

- `packages/cezar/src/index.ts:327` — `rollback: { type: 'string' }` in the single top-level
  `parseArgs({ options: {...} })` call (`:305-343`). This is where the fix has to land: node's
  `parseArgs` has no "optional value" option type, so the fix is necessarily an argv-rewrite *before*
  this call, not a change to the option's `type`.
- `packages/cezar/src/index.ts:175-199` — the established precedent in this same file for
  rewriting/routing `rawArgs` before the strict `parseArgs` call runs (`backup` and `kb` subcommands
  are routed around it entirely because they own their own flag namespace). `--rollback` cannot use
  that exact pattern (it is one flag among many shared with `--strategy`, `--follow`, `--dry-run`,
  etc. inside `server-deploy`, not a whole separate subcommand) — but it is the file's existing idiom
  for "argv needs help before the strict parser sees it," and whatever the spec proposes should read
  as continuous with it, e.g. rewriting a lone `--rollback` token into `--rollback=` in a copied argv
  array passed to `parseArgs({ args: ... })` (today's call passes no `args:`, so it defaults to
  `process.argv.slice(2)` implicitly).
- `packages/cezar/src/index.ts:422,429` — `values.rollback` is what selects `strategy = 'blue-green'`
  and is threaded into `releaseDeployCommand({ rollback: values.rollback, ... })`; downstream of the
  parse, so untouched by the fix.
- `packages/cezar/src/server-install/release-cli.ts:34` — `rollback?: string` with the doc comment
  `/** undefined = not a rollback; '' = roll back to previous; a value = that release. */` — this is
  the contract the argv layer must deliver `''` into, for a bare `--rollback`.
- `packages/cezar/src/server-install/deploy-strategy.ts:213-219` (`runExplicitRollback`) and
  `releases.ts:187` (`rollbackTarget`) — downstream logic; already correct and already tested for
  `rollback: ''`, not implicated by this bug.
- **No `index.test.ts` exists.** CLI-entry-point wiring tests for other flags live as sibling files
  next to `index.ts`: `server-deploy-cli-wiring.test.ts` (the `--dry-run` precedent, most relevant),
  `runs-cli-wiring.test.ts`, `todo-cli-wiring.test.ts`, `cluster-reconcile-cli-wiring.test.ts` — all
  spawn the real CLI (`execFile(process.execPath, ['--import', tsxLoader, entry, ...args])`) against a
  throwaway `cwd`/`CEZ_HOME`. `server-deploy-cli-wiring.test.ts` is the natural home for a new test
  asserting `cezar server-deploy --rollback` (bare, no `=`) does not throw `argument missing` /
  `ambiguous` and is reachable — that is the acceptance criterion 2 test the task asks for.

## Prior decisions this would (or would not) contradict

None found. This is a pure bugfix inside argv preprocessing that an existing spec
(`2026-08-19-non-disruptive-cezar-self-deploy.md`) already anticipated in its own help text and CLI
doc comments (`--rollback[=<id>]`, `'' = roll back to previous`) but never actually implemented at the
`parseArgs` layer. Fixing it does not change `--rollback`'s meaning for any working invocation
(`--rollback=`, `--rollback=<id>`, `--rollback <id>` all keep behaving exactly as today) — it only
makes the previously-broken bare form behave the way the help text already claims.

## Duplicate / in-flight work check

- **No other open worktree touches this.** Diffed every other live worktree's branch against `main`
  for `packages/cezar/src/index.ts`: `cez/183740fe`, `cez/c3e15b6d`, `cez/eeceb869` have no diff on
  that file at all; `cez/9e110775`, `cez/46aebece`, `cez/f73115a0` all carry the *same* unrelated diff
  (an `appendFileSync` import removal + a cluster-CLI comment deletion) — none mention `rollback`.
- `cezar todo list` returned **no todos filed** in this workspace's task tracker (distinct from the
  AGENTS.md-referenced `f97ddd39`, which is not present as a standalone item here).
- `git log --all --grep=rollback -i` shows the readiness-gate fix (`2f91de4b`) and the dry-run flag
  fix (`18707bf1`) as the two most recent rollback-adjacent commits; neither touches `parseArgs`'s
  option table.

## Open questions a spec will have to settle

1. **Exact rewrite rule for "bare".** A lone `--rollback` must become `--rollback=`, but the rule
   has to correctly distinguish it from `--rollback=<id>` (already has `=`, must pass through
   untouched) and from `--rollback <id>` (space-separated value, already works, must not be broken by
   the rewrite eating the following token). The three broken shapes measured above are: (a) exact
   token `--rollback` with nothing after it, and (b) exact token `--rollback` followed by another
   token starting with `-`. A same-array lookahead that special-cases exactly those two is
   sufficient; it should not touch `--rollback=...` or `--rollback <non-dash-token>` at all.
2. **Where exactly the rewrite lives** — inline in `main()` before the `parseArgs({...})` call at
   `index.ts:305`, passing an explicit `args:` array (today's call relies on the implicit
   `process.argv.slice(2)` default), or as a small named helper near the `rawArgs`
   backup/kb-routing block (`:175-199`) for consistency with that file's existing idiom. Both are
   local to `index.ts`; the choice is style, not behavior.
3. **Test placement** — extend `server-deploy-cli-wiring.test.ts` (the direct `--dry-run` precedent,
   same file already spawns the real CLI for `server-deploy`) versus a new sibling file. The former
   seems to match the file's existing single-purpose-per-wiring-file pattern
   (`server-deploy-cli-wiring.test.ts` already exists for exactly this command) more closely than
   inventing a new file.
4. **Does the fix also need a positive assertion that rollback actually selects `blue-green` and
   reaches `releaseDeployCommand`** (not just "doesn't throw an argv error")? The bug report's
   acceptance criterion 1 is "`cezar server-deploy --rollback` (no value) rolls back to previous" —
   the CLI-wiring test can prove reachability and `values.rollback === ''`, but proving an actual
   rollback happened end-to-end is what `release-cli.test.ts`'s existing `runRollbackCli` harness
   already covers logic-side (with `rollback: ''` passed directly, bypassing argv). The spec should
   decide whether "reachable with the right value" (wiring test) plus "`''` behaves correctly"
   (already-covered logic test) together satisfy criterion 1, or whether a full CLI-level rollback
   E2E is also expected.
