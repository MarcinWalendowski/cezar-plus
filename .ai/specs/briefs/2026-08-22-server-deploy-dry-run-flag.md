# Brief — `server-deploy` has no `--dry-run` flag; the plan is reachable only via `CEZ_DRY_RUN=1` (and not even always)

**Task id:** ac844128-622e-441c-a7d0-d264b87f51ff
**Step:** 1/8 — Gather the record (this document is a brief, not a spec; no code written here)

## Problem, in this repo's own terms

`cezar server-deploy --strategy=blue-green --dry-run` fails argv parsing — `parseArgs`
has no `dry-run` option, so it's rejected as an unknown flag. The only way to preview a
deploy today is the env var `CEZ_DRY_RUN=1`, which is undiscoverable from `--help` and
from the command itself.

**Correction to the task's own framing, found while mapping the code (not previously
recorded anywhere):** the task description says "the plan is reachable only via
`CEZ_DRY_RUN=1`" and suggests "OR it with the env var." That's only true for the
**default `restart` strategy**. For `--strategy=blue-green` / `--rollback` (the
dispatch branch at `packages/cezar/src/index.ts:347-375`, which calls
`releaseDeployCommand`), `CEZ_DRY_RUN` is **never read at all** — `ReleaseDeployCliOptions`
(`packages/cezar/src/server-install/release-cli.ts:31-44`) has no `dryRun` field, and
`releaseDeployCommand` (`release-cli.ts:61-72`) never passes `dryRun` into
`runReleaseDeploy`. So today, `CEZ_DRY_RUN=1 cezar server-deploy --strategy=blue-green`
does a **real, unguarded deploy** — stages a release, flips the symlink, restarts the
unit. The exact repro the task names (blue-green) is the one path where even the
"safest" workaround silently doesn't work. This means the fix isn't just "add a flag
and OR it with the env" on one code path — the env var itself needs wiring into the
blue-green branch too, or the brief/spec needs to explicitly scope which strategies
`--dry-run`/`CEZ_DRY_RUN` cover.

## What the record already decided (with citations)

- **`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`** (= KB `specs-594acc539b36`,
  cited in the task's Knowledge section) is the spec that introduced `--strategy=blue-green`,
  `--rollback[=<id>]`, `--follow`. It states the CLI contract verbatim at `:624-625`:
  `cezar server-deploy [--strategy=restart|blue-green] [--follow] [--rollback [<releaseId>]]`.
  **It never mentions `--dry-run` or `CEZ_DRY_RUN` anywhere in its prose** (confirmed via
  full-file grep) — a `--dry-run` flag is genuinely net-new CLI surface, not something this
  spec already promised and left unimplemented. Default strategy stays `restart` "until P3
  and P4 are both live on the box" (`:521`) — orthogonal to this task, don't touch.
  Status: **QA Needed, reopened** 2026-08-21 (criterion 1 — run survives cutover — failed a
  controlled re-measurement) — this task's fix should not block on or reopen that; it's a
  separate concern (cutover/re-attach), not dry-run.
- Same spec documents a known `parseArgs` defect on the sibling `--rollback` flag: bare
  `--rollback` dies in parsing even though help advertises `--rollback[=<id>]`; workaround
  is `--rollback=` (`:169-171`, `:114-116`, filed as todo `f97ddd39`). **Relevant precedent**:
  this codebase's `parseArgs` usage has already bitten a boolean/optional-value flag once;
  a plain `type: 'boolean'` flag like `--dry-run` doesn't have that failure mode, but it's
  worth the spec noting the precedent so the same mistake isn't repeated.
- KB `notion-41a043347b70` (2026-08-21, rootless deploy provisioning): confirms
  `server-deploy --strategy=blue-green` now runs unprivileged via a scoped polkit rule; one
  fallback path (`self-safe-deploy.ts`'s `buildSystemdRunArgv`) still shells out to a
  *system* `systemd-run` transient unit and is deliberately kept root-only. Not directly
  relevant to `--dry-run`, but worth confirming a dry-run short-circuit happens **before**
  that re-exec branch (it does — see below).
- `BACKWARD_COMPATIBILITY.md:14` explicitly enumerates `CEZ_DRY_RUN` as a compatibility-locked
  env var. **The task's "keep `CEZ_DRY_RUN` working" acceptance criterion is not just a nice-to-have
  here — it's a documented compatibility contract.** Any fix must not change `CEZ_DRY_RUN`'s
  existing (if narrower-than-assumed) behavior on the `restart` path.
- No spec, brief, or KB entry prescribes `--strategy=blue-green` printing a plan by default
  (the task's "consider whether..." aside) — see Open Questions.

## Code actually involved (file:line)

**Argv parsing** — one shared `parseArgs` options block for all `server-*` commands,
`packages/cezar/src/index.ts:249-281`. Relevant existing flags: `follow: { type: 'boolean',
default: false }`, `reinstall: { type: 'boolean', default: false }` — a new `'dry-run': {
type: 'boolean', default: false }` fits the existing style directly.

**Dispatch, `server-deploy` case** — `index.ts:347-375`:
```ts
case 'server-deploy': {
  const strategy = values.strategy ?? (values.rollback !== undefined ? 'blue-green' : 'restart');
  if (strategy !== 'restart') {
    process.exitCode = await releaseDeployCommand({
      strategy, rollback: values.rollback, follow: Boolean(values.follow),
      source: values.source ?? repoRoot, linkPath: values['link-path'],
      releasesDir: values['releases-dir'], releaseId: values['release-id'],
      unit: values.unit, port: portExplicit ? Number(values.port) : undefined,
      sha: values.sha, note: values.note,
      // dryRun is NOT passed here today — this is the gap.
    });
    return;
  }
  await serverCommand('deploy', repoRoot, values.platform, { yes: Boolean(values.yes), domain: values.domain });
  return;
}
```

**`restart` path** (already env-gated) — `index.ts:1100`, inside `runOpts` shared by
`server-install`/`server-uninstall`/`server-deploy`-via-`serverCommand`:
```ts
const runOpts = { dryRun: process.env.CEZ_DRY_RUN === '1', assumeYes: flags.yes, ... };
```
Threaded into `packages/cezar/src/server-install/engine.ts` (dryRun plumbed at
`:25,95,96,100,101,108,109,118,119,128`).

**`blue-green`/`rollback` path** — `packages/cezar/src/server-install/release-cli.ts:31-44`
(`ReleaseDeployCliOptions` — no `dryRun` field) and `:61-72` (`releaseDeployCommand` — never
reads `CEZ_DRY_RUN`, never passes `dryRun`). This is where the new flag must be wired in,
in addition to `index.ts`.

**Where `dryRun` is already fully honoured** (the capability the task says "exists") —
`packages/cezar/src/server-install/release-deploy.ts`, `runReleaseDeploy(options)`:
- `:326` — short-circuits before the P2 re-exec/`systemd-run` handoff: `if (options.dryRun)
  return { ok: true, detachedUnit: \`dry-run:${releaseId}\` };`
- `:353` — dry-run also **skips** the "must already be a release symlink" guard
  (`if (!options.dryRun && existsSync(linkPath) && !isMigrated(linkPath))`) — bypassed, not
  still enforced; worth noting in the spec so a dry-run on an unmigrated `/opt/cezar` doesn't
  falsely appear safe on all fronts.
- `:399-401` — the entire "plan" output is one line:
  ```ts
  if (options.dryRun) {
    log(`DRY RUN — would stage ${options.source} → ${releaseDir(releasesDir, releaseId)}, smoke-boot it, flip ${linkPath}, restart ${unitName}, probe :${port}/api/v1/ready.`);
    return { ok: true };
  }
  ```
  This satisfies "prints the plan, exits 0, changes nothing" as-is once `dryRun` reaches it.
- Confirmed by existing unit test `release-deploy.test.ts:198-205` ("a dry run changes
  nothing") — asserts `rec.staged` empty, `rec.restarts === 0`. This test calls
  `runReleaseDeploy({ dryRun: true })` directly, **not** through the CLI — so the CLI-level
  wiring (both branches, the new flag, the OR-with-env behavior) has **zero** existing test
  coverage. A spec-level test plan needs to add CLI-level coverage, not just rely on this.

**`--help` text** — `index.ts:89-95`, inside the `HELP` template literal (starts `:60`):
```
  cezar server-deploy       redeploy a new version (reload the service) + verify
                              --strategy=blue-green   stage a release, smoke-boot it, flip, probe,
                                                      auto-roll-back (spec 2026-08-19)
                              --rollback[=<id>]       flip back to the previous release + restart
                              --follow                tail the deploy running in its own unit
  cezar server-migrate-releases
                            one-shot: /opt/cezar → release symlink + socket/slice units (--yes to apply)
```
No `--dry-run` line exists; the acceptance criterion "appears in `cezar --help` under
server-deploy" means adding one here, indented to match the other sub-flags.

**Precedent shape — `server-migrate-releases`** (dry-by-default, `--yes` to apply):
same `parseArgs` block, only relevant option is the existing global `yes: { type: 'boolean',
default: false }` (`index.ts:261`). Dispatch (`index.ts:376-390`) passes `apply: Boolean(values.yes)`.
Implementation `migrateReleasesCommand` (`release-cli.ts:141-221`) always builds and prints
a `plan: string[]` up front (`:208-209`), then gates only whether `actions` execute on
`opts.apply`. **This is a different shape than what's being asked for here** — the task
does not ask to flip `server-deploy` to dry-by-default (that would be a much bigger,
higher-risk behavior change to a command with standing push/deploy authorization); it asks
for an opt-in `--dry-run` flag. The task's own "Consider whether `--strategy=blue-green`
should print its plan by default" aside floats the bigger change — flag it as an open
question, don't decide it here.

## `CEZ_DRY_RUN` — every place that must keep working unchanged (compatibility contract)

- `index.ts:1100` (the read this task extends/ORs).
- `engine.ts` (install engine plumbing, restart-path only).
- `auto-name.ts:31` — unrelated feature, same env var, do not touch.
- `mock-claude.mjs` — mock CLI swap, unrelated to server-deploy.
- `test/e2e/package-cli.test.ts:82,120,213` — sets `CEZ_DRY_RUN=1` for `cezar run …` e2e,
  **not** `server-deploy` — no existing harness exercises `CEZ_DRY_RUN` against
  `server-deploy` at all today (confirms there's no regression risk to an existing
  server-deploy harness, only to the `restart`-path behavior itself).
- `packages/web/e2e/*.ts`, `.ai/scripts/test-env-up.sh` — unrelated harness usage.
- `README.md`, `AGENTS.md`, `.env.example`, `BACKWARD_COMPATIBILITY.md:14` — docs/contract
  surface. Per this repo's own "Zero config" doctrine (AGENTS.md), adding a new `--dry-run`
  flag doesn't require touching `.env.example` (it's not a new env var), but if the fix
  changes what `CEZ_DRY_RUN` covers (i.e., wires it into the blue-green path for the first
  time), that's a behavior change worth a line in `BACKWARD_COMPATIBILITY.md` and/or
  `AGENTS.md` since both already document the var.

## Duplicate/in-flight work check

**None found — task is genuinely open.** Checked: this worktree (`cez/ac844128`) is clean,
no prior commits on its branch. All 14 sibling task worktrees checked for branch names,
recent commits, and diffs touching `index.ts`/`release-deploy.ts` — none relate. Whole-repo
`git log --all --grep` for dry-run/server-deploy/task-id turns up only unrelated historical
work (npm preview publishing, `cezar run` mock dry-run tests, the original server-deploy
npx-cache fix #696/#697). `gh pr/issue list` for "dry-run server-deploy" returned no results
(not an auth failure). Four existing briefs mention "dry-run" but all refer to the unrelated
`cezar run mock:done` / `package-cli.test.ts` dry-run test path, not `server-deploy`.

## Open questions a spec will have to settle

1. **Scope of the fix given the correction above**: does `--dry-run` (and `CEZ_DRY_RUN`,
   to keep them equivalent) need to cover **both** the `restart` path (already works) and
   the `blue-green`/`rollback` path (currently doesn't honour either)? The acceptance
   criteria only test the blue-green case explicitly — that's also the case that's
   currently completely unguarded, so the spec should treat wiring `dryRun` into
   `releaseDeployCommand`/`ReleaseDeployCliOptions` as in-scope, not optional.
2. Should `--dry-run` also imply/require `--strategy=blue-green` semantics for the
   `rollback` sub-mode, or does a dry-run rollback need its own plan-print path in
   `runReleaseDeploy`/`deploy-strategy.ts` (untraced by this brief — the sub-agent
   confirmed `:326/:353/:399-401` cover the deploy path; rollback's dry-run behavior
   inside `release-deploy.ts` wasn't separately enumerated and should be checked in the
   spec/implementation step).
3. **The task's own suggestion "Consider whether `--strategy=blue-green` should print its
   plan by default"** — no record settles this either way. It's a bigger, riskier change
   (changes default output/behavior of a live, standingly-authorized deploy command) than
   the flag itself. Recommend treating it as explicitly out of scope for this fix unless
   the spec author decides otherwise, and saying so in the spec rather than silently
   dropping it.
4. Test coverage is currently zero at the CLI-wiring level (only the library function
   `runReleaseDeploy` is unit-tested). The spec's verification section needs a new
   CLI-level test (e.g. an `index.ts`-level or `release-cli.ts`-level test asserting
   `--dry-run` and `CEZ_DRY_RUN=1` both short-circuit the blue-green branch with no
   staged release / no restart), since "plan the test up front" is a standing instruction
   and none of this path is covered today.

## What I could not find

- No record of *why* `CEZ_DRY_RUN` was ever wired only into the `restart` path and never
  the blue-green/rollback path added later by the 2026-08-19 spec — likely just sequencing
  (blue-green was added after the env-var convention existed, and nobody re-threaded it),
  not a deliberate decision. No commit message or spec text explains an intentional
  omission.
- No prior discussion of a rollback-specific dry-run plan format inside
  `release-deploy.ts`/`deploy-strategy.ts` beyond the deploy-path lines cited above.

---

**Path:** `.ai/specs/briefs/2026-08-22-server-deploy-dry-run-flag.md`
