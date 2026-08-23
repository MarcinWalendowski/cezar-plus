# Bare `--rollback` dies in argv parsing, so the emergency command is the one that does not work

**Status: IMPLEMENTED, QA Needed.** P1 (the argv rewrite, `packages/cezar/src/argv.ts` and the two
edits it plugs into), P2 (the tests: `argv.test.ts`, four new cases in
`server-deploy-cli-wiring.test.ts`, one new case in `release-deploy.test.ts`) and P3 (the record
correction: `AGENTS.md:13`, `BACKWARD_COMPATIBILITY.md` section 1, this corpus note, and
`f97ddd39` marked done in the main checkout's `.ai/cezar/todos.json`) are all landed on commit
`6863f173`, pushed to `origin/cez/e4faf470` and merged to `origin/main` at `c8afc4e5` (PR
[#10](https://github.com/MarcinWalendowski/cezar/pull/10)). Verification §4's full gate suite has
since run to completion (see Status log): `npm run typecheck`, `npm run test:unit` (44/44), `npm
run build`, and `npm run test:package` (18/18) all EXIT=0; `npm test` EXIT=1 with three failures,
all independently confirmed pre-existing and unrelated to this diff. **Deployed to production
2026-08-23T11:16:42Z** on `prod-host` as release `20260823T111632Z-902be14a` (see Status
log) — verified live via `GET /api/v1/ready` and the deployed CLI's own bare `--rollback
--dry-run`. Verification section 5, the runtime E2E on a scratch `systemd --user` install proving
a real rollback moves the symlink on both the inline and detached paths, has still NOT been run,
so this stays QA Needed rather than Done pending that step. Originally written 2026-08-23 against `HEAD` =
`84fb8237` (branch
`cez/e4faf470`, worktree `e4faf470-0b38-42ec-8335-5c9b6da5c8c7`). Every file and line cited below was
re-opened at that commit for this document, and every claim about `node:util`'s `parseArgs` was
measured by running it (node v22.23.2 on `prod-host`), not read from documentation. Step 1 of
this run left `.ai/specs/briefs/2026-08-23-bare-rollback-argv-trap.md`; where this spec and that
brief differ, this spec re-measured and wins (differences noted inline).

The defect is todo `f97ddd39`, named as still open in `AGENTS.md:13` (the `prod-host`
correction block: "Two flag traps: bare `--rollback` dies in argv parsing, use `--rollback=` (todo
`f97ddd39`) ... `f97ddd39` (the bare `--rollback` argv trap) is still open"). Its sibling trap,
`6497f002` (a rollback never probed readiness), is fixed and merged (`2f91de4b`, merged `c31af208`,
`.ai/specs/2026-08-22-rollback-readiness-gate.md`) and is downstream of this bug, so it neither
causes nor cures it. `f97ddd39` has no standalone *knowledge* document in this corpus snapshot (`grep -rl f97ddd39` over
the KB and `notion-export/` returns nothing but quotations of that same `AGENTS.md` passage), but it
does have a live tracker row: `.ai/cezar/todos.json`, `id: f97ddd39-47e1-4fdf-8222-b77b6782a604`,
`status: "todo"`, `priority: "high"`, filed `2026-08-21T18:42:27.039Z` with this task's exact
summary and acceptance criteria. Both that row and `AGENTS.md:13` are the record of the defect, and
Phase 3 closes both.

## TLDR

`cezar server-deploy --rollback`, with no `=value`, exits 1 with `Option '--rollback <value>'
argument missing` and never reaches any deploy code. The CLI help at `packages/cezar/src/index.ts:118`
advertises `--rollback[=<id>]` and `ReleaseDeployCliOptions.rollback`'s own doc comment
(`server-install/release-cli.ts:34`) says `''` means "roll back to previous", but the option is declared
`rollback: { type: 'string' }` at `index.ts:327` and node's strict `parseArgs` has no optional-value
mode: a `string` option's value is always required. The fix is one argv rewrite in front of
`parseArgs` (a lone `--rollback` token becomes `--rollback=`), one token changed in
`server-install/release-deploy.ts:605` so cezar stops generating the broken shape itself, plus a
subprocess-level CLI-wiring test, because no existing test touches `parseArgs` at all. No accepted
invocation changes meaning: `--rollback=`, `--rollback=<id>` and `--rollback <id>` all keep behaving
exactly as they do today on the inline path.

**This is not only an operator-typing bug.** `reExecCommand`
(`server-install/release-deploy.ts:604-605`) pushes the literal bare `--rollback` into the transient
unit's argv whenever a rollback re-execs, and always appends `--release-id=…` after it, so the
detached child dies on `argument is ambiguous` while the parent returns `{ ok: true, detachedUnit }`
and the CLI prints a handoff message and exits 0. On that path the bug fails **open**, not closed.

## Problem

### What actually happens, measured

Run at `HEAD` = `84fb8237`, real CLI, throwaway `cwd` and `CEZ_HOME`:

```
$ cezar server-deploy --rollback
Option '--rollback <value>' argument missing
$ echo $?
1
```

The message comes from node, thrown out of `parseArgs` (`index.ts:305`) and printed by the process
tail at `index.ts:1914-1917`, which catches everything `main()` rejects with and exits 1. Dispatch
(`case 'server-deploy'`, `index.ts:416`) is never reached, so nothing on the box is touched.

**The "fails closed" reassurance holds for the inline path only, and the other path is worse.**

- **Inline** (no re-exec): exit 1, `argument missing`, nothing staged, flipped or restarted. Useless
  but safe, which is why this has been survivable.
- **Re-exec** (the detached transient unit): **fails open.** The parent builds the child argv itself
  with `reExecCommand` (`server-install/release-deploy.ts:602-618`), which emits the bare
  `--rollback` at `:604-605`, then hands off at `release-deploy.ts:528-545` and returns
  `{ ok: true, detachedUnit: releaseId }` — where `releaseId` is the literal string `'rollback'` for
  an empty rollback (`:483-485`). `server-install/release-cli.ts:88-92` sees `detachedUnit`, prints
  "Deploy is running outside this process so a restart cannot kill it.", and returns **0**. The
  operator sees success. The child died in argv parsing and no rollback happened, and the only trace
  is the argv error inside `deployLogPath('rollback')`.

That raises this defect above "useless but safe": on the path cezar itself drives, the emergency
command reports success and does nothing. And rollback is the emergency path, so the shape an
operator types under pressure is the bare flag.

### Why, exactly

`node:util`'s `parseArgs` supports exactly two option types, `boolean` and `string`, and a `string`
option's value is mandatory. There is no third "optional value" type and no per-option setting that
makes one. Measured directly against node v22.23.2 with this repo's own option table:

| argv | result today |
| --- | --- |
| `--rollback` (end of argv) | throws `ERR_PARSE_ARGS_INVALID_OPTION_VALUE`: `Option '--rollback <value>' argument missing` |
| `--rollback --dry-run` | throws `ERR_PARSE_ARGS_INVALID_OPTION_VALUE`: `Option '--rollback' argument is ambiguous.` |
| `--rollback --` | throws the same `ambiguous` error |
| `--rollback abc123` | works, `values.rollback === 'abc123'` |
| `--rollback=` | works, `values.rollback === ''` |
| `--rollback=r1` | works, `values.rollback === 'r1'` |

Two things worth pinning, because a fix designed without them would be wrong:

1. **node refuses to swallow a following `--flag` as the value.** `--rollback --dry-run` is a hard
   error, not a silent `values.rollback === '--dry-run'`. So the current behaviour is safe, merely
   useless, and the fix is not repairing a silent mis-parse.
2. **`--rollback abc123` (space separated, no `=`) already works today** and is part of the shipped
   surface. Any rewrite must not eat the token after `--rollback`.

So the broken set is precisely: the exact token `--rollback` with nothing after it, or with a token
starting with `-` after it. Two of the three ways to reach that set are "an operator typed the bare
emergency flag." The third is not an operator at all.

**Third case: cezar generates the broken shape itself.** `reExecCommand`
(`server-install/release-deploy.ts:602-618`) builds the transient unit's argv, and at `:604-605`
does

```ts
argv.push(options.rollbackTo ? `--rollback=${options.rollbackTo}` : '--rollback');
```

so an empty `rollbackTo` emits the bare token. It is never the last token: `--source=…` follows when
`options.source` is set (`:606`), and `--release-id=${releaseId}` is appended **unconditionally** at
`:616`. The child argv therefore always has a dash-led token after the bare flag, which is exactly
the `argument is ambiguous` shape — deterministically, on every empty rollback that re-execs.

That fires whenever `decideReExec` (`server-install/self-safe-deploy.ts:84`) returns `reExec: true`
for a rollback: not already detached (`CEZ_DEPLOY_DETACHED` unset), running inside `cezar.service`'s
cgroup, effective `KillMode` neither `process` nor readable, and `systemd-run` available. That is
precisely the agent-driven self-deploy case this whole spec family exists for. It does **not** fire
on `prod-host` today only because that box reads `KillMode=process`
(`self-safe-deploy.ts:107-112`), which short-circuits the escape before `systemdRunAvailable` is even
consulted. So the fail-open path is one unit-file edit away from live, and is live on any box that
has not been migrated.

### Why no test caught it

Every existing test of the rollback path calls `releaseDeployCommand({ rollback: '', ... })` or
`runRollback(...)` directly, below the argv layer:

- `server-install/release-cli.test.ts:292` (`describe('releaseDeployCommand rollback')`),
  constructing `rollback: ''` by hand at `:342`.
- `server-install/deploy-strategy.test.ts:183` (`describe('explicit rollback')`) and `:206`
  (`describe('explicit rollback readiness gate')`).

None of them constructs an argv string, so none of them can see the option table. This is the same
hole the `--dry-run` work already diagnosed and closed for its own flag:
`server-deploy-cli-wiring.test.ts`'s header comment states the reason it exists, that "a unit test on
`releaseDeployCommand` never touches `parseArgs` at all"
(`.ai/specs/2026-08-22-server-deploy-dry-run-flag.md`, commit `18707bf1`).

### What the record already says

- `AGENTS.md:13` documents the trap and its workaround (`--rollback=`) and marks `f97ddd39` open.
  That line is what a session reads before deploying on `prod-host`, and it is currently
  correct; this spec's Phase 3 is what makes it wrong and must correct it in place.
- `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` introduced `--rollback` as a flag and
  wrote both the `--rollback[=<id>]` help string and the `'' = roll back to previous` contract. It
  never implemented the argv side of that contract. That spec is QA-reopened for an unrelated reason
  (mid-run deploy continuity on blue-green cutover), which this fix does not touch.
- `.ai/specs/2026-08-22-server-deploy-dry-run-flag.md` (`18707bf1`) is the precedent for correctly
  adding or fixing a `server-deploy` flag: register it, thread it, add a subprocess CLI-wiring test.
- `.ai/specs/2026-08-22-rollback-readiness-gate.md` (`2f91de4b`) fixed the sibling bug in
  `runRollback`, far downstream of `parseArgs`. Unaffected by, and does not fix, this one.

No prior decision contradicts the fix. It changes no working invocation's meaning; it only makes the
previously broken bare form do what the help text has claimed since the flag shipped.

## Solution

**One argv rewrite, immediately in front of the single top-level `parseArgs` call**
(`packages/cezar/src/index.ts:305`). A lone `--rollback` token is rewritten to `--rollback=` before
the strict parser sees it, so `values.rollback === ''`, which is exactly the value the CLI contract
already defines as "roll back to the previous release."

```ts
// node's `parseArgs` has no optional-value option type: a `{ type: 'string' }` option's value is
// always REQUIRED, so `--rollback` alone throws `argument missing` and `--rollback --follow` throws
// `argument is ambiguous` (node deliberately refuses to read the next flag as the value). Both are
// the shape an operator types under pressure, and the help at `:118` has advertised
// `--rollback[=<id>]` since the flag shipped. Rewrite the lone token into the explicit-empty form
// the parser does accept. Only a token that IS the flag, and is followed by nothing or by another
// dash-led token, is touched: `--rollback <id>` (space separated) already works and must keep
// working, and `--rollback=<id>` never matches.
const OPTIONAL_VALUE_FLAGS = new Set(['--rollback']);

function withOptionalFlagValues(argv: string[]): string[] {
  const out: string[] = [];
  let terminated = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (terminated) { out.push(token); continue; }
    if (token === '--') { terminated = true; out.push(token); continue; }
    const next = argv[i + 1];
    out.push(
      OPTIONAL_VALUE_FLAGS.has(token) && (next === undefined || next.startsWith('-'))
        ? `${token}=`
        : token,
    );
  }
  return out;
}
```

and at the call site:

```ts
const { values, positionals } = parseArgs({
  args: withOptionalFlagValues(rawArgs),
  options: { /* unchanged, including `rollback: { type: 'string' }` */ },
  allowPositionals: true,
});
```

Four properties this design is chosen for:

- **`rawArgs` itself is not mutated.** The rewrite produces a new array used only by `parseArgs`. The
  subcommands routed around the strict parser from raw argv (`backup` `:183`, `kb submit` `:209`,
  `kb` `:214`, `cluster` `:228`, `todo` `:243`, `run stats` `:256`, `runs`/`run reopen` `:274`,
  `run-broker` `:300`) keep receiving verbatim argv. None of them defines `--rollback`, so this is
  belt and braces, but it keeps the blast radius at one call.
- **Passing `args:` explicitly is behaviour-neutral.** Today's call passes no `args:` and therefore
  defaults to `process.argv.slice(2)`, which is byte-identical to `rawArgs` as constructed at
  `index.ts:182`. Verified by reading both lines, not assumed.
- **`--` is honoured.** Tokens after the terminator are passed through untouched, so
  `cezar server-deploy -- --rollback` keeps meaning "a positional that looks like a flag."
- **The option type does not change.** `rollback: { type: 'string' }` stays, so `--rollback=<id>` and
  `--rollback <id>` parse exactly as they do now. Turning it into a `boolean` would be the other
  obvious fix and is wrong: it would delete the ability to name a release.

**Nothing downstream changes, with one deliberate exception.** `index.ts:422`
(`values.rollback !== undefined` selecting `strategy = 'blue-green'`) and `:429`
(`rollback: values.rollback` into `releaseDeployCommand`) both already handle `''` correctly, and
`server-install/release-cli.ts:34`'s contract and `server-install/deploy-strategy.ts:214`'s
`runRollback` (with the readiness gate from `2f91de4b`) are unchanged and already covered.

**The exception: `reExecCommand` emits `'--rollback='` instead of `'--rollback'`** for the empty
case, at `server-install/release-deploy.ts:605`. One token, no other edit:

```ts
argv.push(options.rollbackTo ? `--rollback=${options.rollbackTo}` : '--rollback=');
```

The rewrite layer above would repair this argv too, so this is redundant by construction — and it is
still the right change. A parent process that fully controls its child's argv must not depend on a
normalisation layer to parse an argv it can simply spell unambiguously. Belt and braces: the
detached path stays correct if the rewrite is later narrowed, moved, or removed, and the generated
argv reads as what it means rather than as the shape that used to be a bug.

**No help-text change.** `index.ts:118` already reads `--rollback[=<id>]`. It has been a promise the
code did not keep; this fix makes it true. Changing it would be recording the bug as the contract.

### Decisions on the brief's four open questions

1. **Rewrite rule:** the lookahead above, with the `--` terminator honoured. The brief proposed the
   same two-case trigger; this spec adds the terminator handling, which the brief did not mention.
2. **Where it lives:** its own tiny module, `packages/cezar/src/argv.ts`, exporting
   `OPTIONAL_VALUE_FLAGS` and `withOptionalFlagValues`; `index.ts` imports it and applies it at the
   existing `parseArgs` call via an explicit `args:`. Not a `rawArgs` mutation, and not a
   whole-subcommand reroute in the `:182-303` idiom, because `--rollback` is one flag inside
   `server-deploy`'s shared namespace and not a subcommand that owns its own flags.
   **It cannot live beside `main()` in `index.ts`**, which was this spec's first answer and is not
   implementable: `index.ts:1914` calls `main()` unguarded at module scope, so importing anything
   from that file runs the whole CLI as an import side effect. Nothing in the repo imports
   `index.ts`, for exactly that reason — the wiring tests spawn it as a subprocess instead. A
   sibling module keeps the helper unit-testable in-process, matching the `git-refs.ts` /
   `git-refs.test.ts` pattern already used throughout `packages/cezar/src/`.
3. **Test placement:** extend `packages/cezar/src/server-deploy-cli-wiring.test.ts`. It already exists
   for exactly this command, already spawns the real CLI, and its header comment already states the
   argument for this shape of test. A new sibling file would duplicate its harness.
4. **How much proves acceptance criterion 1:** three layers, and the spec is explicit that gates
   alone do not close it. The wiring test proves the bare flag is reachable and yields `''` (the
   argv defect, which is the whole of this bug). `server-install/release-cli.test.ts` /
   `server-install/deploy-strategy.test.ts`
   already prove `''` performs a real rollback to `previous` and now probes readiness. Neither proves
   a real rollback on a real unit, so Verification section 5 keeps a runtime E2E on a scratch
   `systemd --user` install, and the status stays QA Needed until it has actually been run. This is
   the same standard `.ai/specs/2026-08-22-rollback-readiness-gate.md` holds itself to.

## Architecture

```
process.argv.slice(2)  ->  rawArgs  ->  subcommand routing (backup/kb/cluster/todo/runs/...)
                              |            (verbatim argv, untouched by this change)
                              |
                              +--> withOptionalFlagValues(rawArgs)   <-- THE NEW CODE (src/argv.ts)
                                        |   lone `--rollback`  =>  `--rollback=`
                                        v
                                   parseArgs({ args, options, allowPositionals })
                                        |   values.rollback: undefined | '' | '<id>'
                                        v
                                   case 'server-deploy'  (index.ts:416)
                                        |   strategy = values.strategy ?? (rollback !== undefined ? 'blue-green' : 'restart')
                                        v
                                   releaseDeployCommand({ rollback, ... })      server-install/release-cli.ts:53
                                        |
                                        +--> re-exec? reExecCommand() rebuilds argv   server-install/release-deploy.ts:602
                                        |        `--rollback=` (was the bare token)   <-- ONE TOKEN CHANGED
                                        |        systemd-run -> a second cezar process, back in at the top
                                        v
                                   runReleaseDeploy -> runRollback(...)         server-install/deploy-strategy.ts:214
                                        |   target = to ?? rollbackTarget(ledger)   server-install/releases.ts:187
                                        v
                                   flip symlink -> restart unit -> probe /api/v1/ready
```

The change is an argv-normalisation layer plus one token in the argv cezar generates for itself.
Everything below `parseArgs` keeps its current signature and behaviour. Note that the re-exec branch
re-enters this same diagram at the top, in a second process — which is why the argv the parent emits
is subject to exactly the same parser, and why the bug bites there.

## Data models and API contracts

**No data model changes.** No ledger, config, registry or on-disk format is touched.

**`ReleaseDeployCliOptions.rollback` (`server-install/release-cli.ts:34`) is unchanged** and remains
the contract this fix delivers into:

| value | meaning |
| --- | --- |
| `undefined` | not a rollback |
| `''` | roll back to `previous` |
| `'<id>'` | roll back to that release |

**CLI contract, before and after.** Additive per `BACKWARD_COMPATIBILITY.md`'s general rule: an input
that was rejected becomes accepted, and no accepted input changes meaning.

| invocation | today | after |
| --- | --- | --- |
| `server-deploy --rollback` | exit 1, `argument missing` | rolls back to `previous` |
| `server-deploy --rollback --follow` | exit 1, `argument is ambiguous` | rolls back to `previous`, follows |
| `server-deploy --rollback --dry-run` | exit 1, `argument is ambiguous` | prints the rollback plan, changes nothing |
| `server-deploy --rollback=` | rolls back to `previous` (inline) | unchanged |
| `server-deploy --rollback=` **when it re-execs** | exit 0, "handed off", **rolls back nothing** | rolls back to `previous` |
| `server-deploy --rollback=<id>` | rolls back to `<id>` | unchanged |
| `server-deploy --rollback <id>` | rolls back to `<id>` | unchanged |
| `server-deploy -- --rollback` | `--rollback` is a positional | unchanged |

**The one row whose accepted behaviour genuinely changes is the detached case, and that is a fix,
not a regression.** Stated explicitly here so it is findable from the compatibility statement rather
than only from the Problem section: today an empty rollback that re-execs exits 0 having done
nothing, because the parent generates a bare `--rollback` its own child cannot parse
(`server-install/release-deploy.ts:604-605`, `:616`). After this change it performs the rollback the
operator asked for. Nobody can be depending on "exit 0 and no rollback", so `BACKWARD_COMPATIBILITY.md`
§1's additive rule is satisfied; the exit code for that invocation is unchanged on success, and now
correctly becomes non-zero when the rollback itself fails.

**Exit codes are otherwise unchanged.** A successful rollback exits 0; a failed one exits 1 through
the existing branches at `server-install/release-cli.ts:94-126`.

## Phases

Each phase is a reviewable unit. P1 and P2 ship as one commit (house rule: one commit per feature),
but P1 is complete and correct on its own and P2 is the guard that keeps it.

### P1: make the bare flag parse (the fix)

Three files: a new `packages/cezar/src/argv.ts`, the `parseArgs` call in `packages/cezar/src/index.ts`,
and one token in `packages/cezar/src/server-install/release-deploy.ts`.

1. Add `packages/cezar/src/argv.ts` exporting `OPTIONAL_VALUE_FLAGS` and `withOptionalFlagValues`,
   with the comment above (the comment is load-bearing: the next reader must not "simplify" this into
   a `boolean` type or a next-token grab). Its own module rather than `index.ts`, so it can be
   unit-tested in-process — see Solution decision 2.
2. Import it in `index.ts` and pass `args: withOptionalFlagValues(rawArgs)` into the existing
   `parseArgs` call at `:305`.
3. Change the empty-rollback branch at `server-install/release-deploy.ts:605` to push
   `'--rollback='` rather than `'--rollback'`, so the argv cezar generates for its own detached child
   is unambiguous without relying on step 1.
4. Nothing else. No option-table change, no help change, no other downstream change.

Done when `cezar server-deploy --rollback --dry-run` prints a plan instead of an argv error, and the
re-exec argv recorded by `release-deploy.test.ts`'s `spawnDetached` recorder contains `--rollback=`.

### P2: prove it from the real entry point (the test)

`packages/cezar/src/server-deploy-cli-wiring.test.ts`, extending the existing `cli()` harness and
`describe` file. Four cases, all run against the real CLI in a throwaway `cwd` with `CEZ_HOME`
pinned to a temp dir, and all with `--dry-run` so no case can flip a symlink or restart a unit:

1. `['server-deploy', '--rollback', '--dry-run']` (bare flag followed by another flag, the
   `ambiguous` shape): output must not match `/argument missing|ambiguous|unknown option/i`, exit 0.
2. `['server-deploy', '--dry-run', '--rollback']` (bare flag at the end of argv, the
   `argument missing` shape): same assertions. Both shapes are needed because node fails them with
   different errors and a rewrite could plausibly fix one and not the other.
3. `['server-deploy', '--rollback=', '--dry-run']` as the control, so a regression that broke the
   already-working explicit-empty form is caught by the same file.

4. `['server-deploy', '--rollback', 'r1', '--dry-run']`: still reports `r1` and not the previous
   release. **Required, not optional.** Risk 3 below calls eating the next token "the single most
   likely way to get the fix wrong", and Verification §2 already demands this case; a spec that
   listed it as a nice-to-have would be contradicting its own two other sections.

The assertion is deliberately "no argv error, exit 0, and the dry-run plan mentions a rollback"
rather than "a rollback happened": this file's job is reachability. The value semantics of `''` are
already covered by `server-install/release-cli.test.ts:292` and
`server-install/deploy-strategy.test.ts:183`.

**Plus one case in `packages/cezar/src/server-install/release-deploy.test.ts`, for the argv cezar
generates.** That harness already captures the detached argv —
`spawnDetached: (argv) => rec.detached.push(argv)` at `:67`, with `detachedUnit` and `rec.detached`
assertions at `:120` and `:336` — so the case is a few lines and needs no export, no subprocess and
no systemd. Drive a re-exec'ing rollback (`killMode: () => 'control-group'`,
`cgroup: () => INSIDE`, `systemdRunAvailable: () => true`, `rollbackTo: ''`) and assert
`rec.detached[0]` contains `'--rollback='` and never the bare `'--rollback'`. Without this case
nothing in P2 would exercise the fail-open path at all, which is the half of the bug the first draft
of this spec missed.

### P3: correct the record in place

Doc-only, no code.

1. **`AGENTS.md:13`** currently says, correctly today, "bare `--rollback` dies in argv parsing, use
   `--rollback=` (todo `f97ddd39`) ... `f97ddd39` (the bare `--rollback` argv trap) is still open."
   P1 makes that false. Correct it in place with a bolded `CORRECTED 2026-08-23` lead-in naming this
   spec and the commit, leaving the original text below it, in exactly the style that block already
   uses for `6497f002`. This matters more than usual: that paragraph is the deploy runbook for
   `prod-host`, so a stale "use `--rollback=`" is what the next operator reads first.
2. **`BACKWARD_COMPATIBILITY.md`**, section 1 flags bullet: note that `--rollback` accepts the bare
   form as of 2026-08-23, additive, no existing spelling changed.
3. **Corpus note** via `CEZ_KB_WRITE_FILE` (project scope), recording the durable fact that node's
   `parseArgs` has no optional-value type and that this repo's answer is an argv rewrite in front of
   it, so the next flag that wants `[=<value>]` syntax does not rediscover this the hard way.
4. **This spec's own Status log**, and the tracker: mark `f97ddd39` done in the main checkout's
   `.ai/cezar/todos.json` (not the worktree's, per `.ai/specs/2026-08-22-rollback-readiness-gate.md`'s
   status log). **The row exists** — `id: f97ddd39-47e1-4fdf-8222-b77b6782a604`, `status: "todo"`,
   `priority: "high"`, `ts: 2026-08-21T18:42:27.039Z`, carrying this task's exact summary and both
   acceptance criteria. (An earlier draft of this spec said the brief had found no row and that this
   might be a no-op; that was wrong, and the row was read directly for this revision.) Follow the
   `6497f002` precedent a few entries down in the same file: prepend a bolded
   `DONE 2026-08-23 — …` lead-in to `context` naming the commit and this spec, leave the original
   context text below it unchanged, set `archivedAt`, and say plainly which acceptance criterion is
   code-proven versus still awaiting the runtime E2E.

## Risks

1. **A release id that starts with `-`.** With the rewrite, `--rollback -x` becomes `--rollback=`
   plus an unrecognised `-x`, so `parseArgs` fails with `Unknown option '-x'` instead of today's
   `ambiguous`. Both are exit-1 failures with nothing touched, so this trades one error message for
   another and never silently rolls back to the wrong release. Real ids are
   `20260821T181100Z-<sha8>` (`server-install/releases.ts`, and `/opt/cezar-releases` on the prod
   box), never dash-led, and the escape hatch `--rollback=-x` works — and is *literally what node's
   own error text tells the operator to type*, so the trade is better than "one message for
   another": the new failure points at the exact spelling that works. Accepted, not mitigated
   further.
2. **A typo now acts instead of failing closed.** `--rollback` typed by accident used to be an argv
   error; after this it performs a real rollback. That is the requested behaviour and the flag is
   equally destructive today when spelled `--rollback=`, so this fix does not create a new class of
   accident. Two existing guards limit it: rollback probes `/api/v1/ready` and reports failure
   distinctly (`2f91de4b`), and `--dry-run` previews the flip without doing it (`18707bf1`).
3. **The rewrite eating a legitimate space-separated value.** Prevented by the lookahead (only a
   missing or dash-led next token triggers it) and covered by the P2 control case. This is the single
   most likely way to get the fix wrong.
4. **Scope creep into a generic optional-value mechanism.** `--rollback[=<id>]` is the only
   optional-value flag in `HELP` (verified: `grep -n '\[=' packages/cezar/src/index.ts` returns
   exactly `:118`). The set stays at one entry; the helper is a set only so the next one is a
   one-line change rather than a copy of the loop.
5. **Explicit `args:` drifting from `process.argv`.** Today `rawArgs` is `process.argv.slice(2)` at
   `:182` and nothing between there and `:305` mutates either, so this is neutral. If a future change
   inserts argv mutation between those lines, the parser would follow `rawArgs`, which is the
   intended reading anyway.
6. **The fix is invisible to the fast gate if P2 is skipped.** `packages/cezar/vitest.config.ts`
   includes `src/**/*.test.ts`, so the wiring test does run in `npm test`, but it spawns a real node
   subprocess per case and is slow. If it is ever moved or marked skipped, the bug can silently
   return. Keeping it in the file that already exists for this command is the mitigation.

## Verification

Concrete and executable, from the repo root unless stated. Sections 1 to 4 are the gate; section 5 is
what separates QA Needed from Done.

1. **Reproduce the defect first, at the pre-fix commit**, so the fix is proved against a measured
   failure and not an assumed one:
   ```sh
   node --import "$(node -e 'console.log(require("module").createRequire(process.cwd()+"/packages/cezar/package.json").resolve("tsx"))')" \
     packages/cezar/src/index.ts server-deploy --rollback; echo "EXIT=$?"
   ```
   Expected before P1: `Option '--rollback <value>' argument missing`, `EXIT=1`. Expected after P1:
   no argv error (it proceeds into the deploy path; add `--dry-run` to keep it inert).

2. **The new wiring cases:**
   ```sh
   cd packages/cezar && npx vitest run src/server-deploy-cli-wiring.test.ts
   ```
   All cases green, including the two bare-flag shapes and the `--rollback r1` control.

3. **Argv-level unit check** (fast, no subprocess), in a new
   `packages/cezar/src/argv.test.ts` importing `withOptionalFlagValues` from
   `packages/cezar/src/argv.ts` directly — which is why the helper lives in its own module and not
   in `index.ts`, whose module scope runs `main()` (Solution decision 2). Picked up by the existing
   `include: ['src/**/*.test.ts']` in `packages/cezar/vitest.config.ts`, so it needs no config
   change. Five assertions:
   ```sh
   cd packages/cezar && npx vitest run src/argv.test.ts
   ```
   1. `['server-deploy','--rollback']` maps to `['server-deploy','--rollback=']`
   2. `['--rollback','r1']` is returned untouched (the next token is not eaten)
   3. `['--rollback=r1']` is returned untouched
   4. everything after a `--` terminator is returned untouched, so
      `['server-deploy','--','--rollback']` does not gain an `=`
   5. `['--rollback','--dry-run']` maps to `['--rollback=','--dry-run']` — the `ambiguous` shape,
      which is the one the re-exec path generates and the one node fails differently from case 1

4. **Full gates:** `npm run typecheck`, `npm test`, `npm run build`, `npm run test:unit`,
   `npm run test:package`. Any failure must be shown to be pre-existing by a control run at the
   merge-base before it is called unrelated, per the sibling specs' practice. Quote failures rather
   than summarising them.

5. **Runtime E2E, the one that closes acceptance criterion 1** (not yet run; this is why the status
   after implementation is QA Needed, not Done). On a scratch `systemd --user` install with at least
   two releases in the ledger, so nothing on the live box is flipped to prove a CLI fix:
   1. `cezar server-deploy --rollback --dry-run` prints the rollback plan naming the previous
      release, exits 0, and the symlink target and unit state are byte-identical afterwards.
   2. `cezar server-deploy --rollback` (bare, no dry run) flips the symlink to the previous release,
      restarts the unit, and reports the readiness pass from `2f91de4b`. Verify the symlink target
      changed and `GET /api/v1/health`'s `deploy.releaseId` reports the previous release.
      **Run this twice, once per path**, because they fail differently and only the first is covered
      by everything above:
      - **inline**, over ssh or from outside the unit's cgroup, where `decideReExec` returns
        `reExec: false`;
      - **detached**, driven from inside the scratch unit's own cgroup with `KillMode` left at
        `control-group` and `systemd-run` available, so `decideReExec` returns `reExec: true` and
        `reExecCommand` generates the child argv. Today that path prints the handoff message, exits
        0 and rolls back nothing; after the fix the symlink must actually move. Read
        `deployLogPath(...)` for the child's own output — the parent's exit code cannot tell you
        whether the child parsed its argv, which is precisely the failure mode being closed.
   3. `cezar server-deploy --rollback --follow` reaches the follow path rather than an argv error.

6. **On `prod-host`, after the deploy of this change,** the read-only half only:
   `cezar server-deploy --rollback --dry-run` prints a plan and exits 0. A real bare rollback of the
   live service is not part of verification; section 5 is where the destructive path is proved.

## Record

On landing, and in the same session as the code change, per the workspace rules:

- Update this document's Status line and add a Status log section with the commit, what was gated,
  and what remains (section 5 until it has been run).
- `AGENTS.md:13` corrected in place (P3 item 1). This is the highest-value record edit in the task,
  because that paragraph is the prod deploy runbook.
- `BACKWARD_COMPATIBILITY.md` section 1 flags bullet (P3 item 2).
- Corpus note via `CEZ_KB_WRITE_FILE` (P3 item 3), citing this spec.
- Tracker: `f97ddd39-47e1-4fdf-8222-b77b6782a604` marked done in the main checkout's
  `.ai/cezar/todos.json` (the row exists and was read for this spec), following the `6497f002`
  precedent in that same file — see P3 item 4.

## Status log

- 2026-08-23 (implementation step): P1, P2 and P3 landed on `cez/e4faf470`, not yet committed.
  `packages/cezar/src/argv.ts` added (`OPTIONAL_VALUE_FLAGS`, `withOptionalFlagValues`); wired into
  the single top-level `parseArgs` call at `index.ts:305` via `args: withOptionalFlagValues(rawArgs)`;
  `reExecCommand` (`server-install/release-deploy.ts:605`) changed to emit `--rollback=` instead of
  the bare token. Tests added: `packages/cezar/src/argv.test.ts` (5 assertions, all from Verification
  §3), four new cases in `server-deploy-cli-wiring.test.ts` (Verification §2, including the required
  `--rollback r1` control), one new case in `server-install/release-deploy.test.ts` asserting the
  detached argv contains `--rollback=` and never the bare `--rollback` (closes the fail-open half of
  the bug). Gated: `npx vitest run src/argv.test.ts src/server-install/release-deploy.test.ts
  src/server-deploy-cli-wiring.test.ts` → 3 files, 45/45 tests passing; `npm run typecheck` → green.
  Manually reproduced `cezar server-deploy --rollback --dry-run --strategy=blue-green` against the
  real CLI on this box: no argv error, exit 0, `DRY RUN — would flip /opt/cezar to the previous
  release and restart cezar.service.` printed (read-only, nothing changed). Record corrected in
  place: `AGENTS.md:13`, `BACKWARD_COMPATIBILITY.md` §1, a corpus note via `CEZ_KB_WRITE_FILE`, and
  `f97ddd39` marked `done`/`archivedAt` in the main checkout's `.ai/cezar/todos.json`. **What
  remains:** Verification §4's full gate suite (`npm test`, `npm run build`, `npm run test:unit`,
  `npm run test:package`) has not been run in this step, only the three touched files plus
  typecheck; and Verification §5's runtime E2E (real rollback on a scratch `systemd --user` install,
  both inline and detached paths) has not been run at all. Status stays QA Needed until both close.

- 2026-08-23 (run-tests step): ran all five gates this repo defines
  (`.ai/agentic.config.json`; there is no separate lint command). `npm run typecheck` → EXIT=0.
  `npm run test:unit` → EXIT=0, 44/44. `npm run build` → EXIT=0 (`check:pack ok — 1158 files`).
  `npm run test:package` → EXIT=0, 18/18. `npm test` → EXIT=1, `Test Files 3 failed | 571 passed |
  2 skipped (576)`, `Tests 3 failed | 10748 passed | 4 skipped (10755)`. All three failures were
  checked against a control (merge-base and/or isolated single-file run) and confirmed pre-existing
  and unrelated to this branch's diff, not new red introduced by P1/P2: `catalog.test.ts` C18
  (documented host-speed budget flake, AGENTS.md trap 3), `add-project-dialog.test.tsx` navigate-race
  (documented flake, AGENTS.md), and `config-api.test.ts:106` (`defaultModels.claude` missing;
  `git diff HEAD` on that file is empty, it imports none of the changed files, and it fails
  identically in isolation at this same HEAD). This closes Verification §4; only §5 (the runtime
  E2E) remains before Done. **Correction to that step's own report:** it stated the `config-api.test.ts`
  failure was "filed as todo `c24889aa-9241-4509-b008-af6706d035e1`" — that row does not exist in
  `.ai/cezar/todos.json` (168 rows checked, no match), so either the write did not land or was never
  made. The failure is not untracked, though: it is a duplicate of pre-existing row
  `72eba946-5cca-4cb4-a700-a484fb627d72` (filed 2026-08-22 by task `9092de31`, `status: "todo"`,
  same file, same line, same symptom), so no new tracker row was needed or has been filed here.

- 2026-08-23 (commit-push step): committed as `6863f173` on `cez/e4faf470`
  (`fix: make bare --rollback work — implement 2026-08-23-bare-rollback-argv-trap`), pushed to
  `origin/cez/e4faf470` (never `upstream`, per this repo's remote convention), opened PR
  [#10](https://github.com/MarcinWalendowski/cezar/pull/10), and self-merged it into `origin/main`
  at `c8afc4e5`, following this repo's established convention of the same author self-merging every
  recent PR. `git merge-base --is-ancestor` confirms this worktree's `HEAD` is now an ancestor of
  `origin/main`.

- 2026-08-23 (document step): confirmed the above against the live repo state rather than trusting
  the progress log — `git log`/`git status` on this worktree (`cez/e4faf470`, clean, `HEAD` =
  `6863f173`), `git fetch origin` + `git merge-base --is-ancestor HEAD origin/main` (true),
  `gh pr list --head cez/e4faf470 --state all` (PR #10, MERGED), and the todo row for `f97ddd39`
  (`status: "done"` in the main checkout's `.ai/cezar/todos.json`). No further code or test changes
  made in this step; only this Status line/log and the cross-references below. **What remains:**
  Verification §5's runtime E2E (real rollback on a scratch `systemd --user` install, both inline
  and detached paths) — the only thing standing between QA Needed and Done.

- 2026-08-23 (deploy step): pulled `origin/main` fast-forward into the main checkout
  (`84fb8237..902be14a`), ran `npm run build` (green, `check:pack ok — 1158 files`), then deployed
  via this box's documented rootless blue-green path (`AGENTS.md` §"Always self-deploy", the
  **user** `systemd-run --user` re-exec, never a system unit): `systemd-run --user
  --unit=cez-deploy-902be14a --collect --property=Type=oneshot
  --working-directory=/var/lib/cezar/loki-labs/cezar
  --setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /usr/bin/node
  packages/cezar/dist/index.js server-deploy --strategy=blue-green
  --source=/var/lib/cezar/loki-labs/cezar --sha=902be14afb8bd7e99f76d723d6a99775cb886e4f`. Result:
  release `20260823T111632Z-902be14a` activated at `2026-08-23T11:16:42.819Z`, ledger-marked
  `healthy: true`, `previous` retained as `20260823T083733Z-84fb8237` for `--rollback`. Verified:
  `GET /api/v1/ready` reports `deploy.sha` = `902be14afb8bd7e99f76d723d6a99775cb886e4f`;
  `/opt/cezar` symlink points at the new release directory. Then ran the spec's own Verification
  §6 read-only check against the **deployed** CLI: `node
  /opt/cezar/packages/cezar/dist/index.js server-deploy --rollback --dry-run` — no argv error,
  prints the rollback plan (`current: 20260823T111632Z-902be14a`, `previous:
  20260823T083733Z-84fb8237`), EXIT=0. This is the fix working on the live box. **Not run in this
  step:** Verification §5's destructive runtime E2E (a real rollback on a *scratch* install, not
  the live box) — still open, and still what keeps this spec at QA Needed rather than Done.
