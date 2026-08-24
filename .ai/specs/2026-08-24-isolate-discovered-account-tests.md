# Discovered Account Test Isolation

**Status:** Implemented, QA Needed until the full hostile-environment gate and remaining validation commands run
**Date:** 2026-08-24
**Repo:** `cezar`
**Branch:** `cez/6509be16` (task `6509be16-c33e-4372-9b8a-5ca862089c49`)
**Brief:** `.ai/specs/briefs/2026-08-24-isolate-agent-profile-tests.md` (KB `specs-3b5d2cdc5f22`)
**Extends:** `.ai/specs/2026-08-14-claude-subscription-autodetect.md` (KB `specs-362123d36be2`, the
discovery this suite covers), `.ai/specs/2026-08-24-second-codex-account-balancing.md` (KB
`specs-d77609665477`, D4, which widened discovery to codex), `.ai/specs/2026-07-29-agent-profiles.md`
(KB `specs-4d06fee89bcd`, `CODEX_HOME` as a relocation boundary),
`.ai/specs/2026-08-22-agent-profile-wiring-cez-kb-test-isolation.md` (the per-suite save/clear/restore
precedent, implemented by `878708f5`)

## TLDR

`packages/cezar/src/server/agent-profiles-discovered-api.test.ts` fakes `HOME` and asserts an
**exact** list of discovered accounts, but never owns `CODEX_HOME`. Production resolves the codex
default as `CODEX_HOME` first and `$HOME/.codex` only as a fallback (`packages/cezar/src/paths.ts:256-264`),
so on any machine where the process inherits `CODEX_HOME` the suite's answer contains a **real login
of the person running the gate**, measured as `/var/lib/cezar/.codex-secondary` with
`second@example.com · Pro` in `/tmp/cezar-b3b5719c-control-parent-agent-profiles.log`.

Two things the brief could not see, both measured while writing this spec:

1. **The three-line fix already landed upstream.** `8219c6f0` ("fix: mock codex in dry runs") adds
   `codexDir: process.env.CODEX_HOME` to `saved`, a `delete` in `beforeEach` and a restore in
   `afterEach`. It is reachable from `origin/main` and **not** from this branch
   (`git merge-base --is-ancestor 8219c6f0 HEAD` → false; `git rev-list --count HEAD..origin/main` → 17).
   So Phase 1 is a **reconciliation, not an authorship**: re-writing the same hunk here is exactly
   the duplicate-fix collision `cez/eeceb869` already had to unpick (`125cfe00`, `c25d8ee5`, `9c896e32`).
2. **The failure is environment-flaky, not deterministic.** In *this* step's own runner env
   `CODEX_HOME` is empty while `CLAUDE_CONFIG_DIR=/var/lib/cezar/.claude-secondary` is set, so the
   same suite on the same box would have gone green here and red in task `b3b5719c`. A green run
   therefore proves nothing on its own: AC1 ("passes regardless of real host Codex profile
   directories") has to be verified with `CODEX_HOME` deliberately pointed at a real host profile.

The spec therefore does three separable things: reconcile with the landed fix (AC1), move the guard
from one suite to the whole `server` vitest project so no *other* suite can inherit a host login
(AC2), and give the endpoint its own codex fixture so the widened contract is actually exercised at
the route rather than merely no longer polluted.

## Problem

### What the suite intends, and what the machine answers

`agent-profiles-discovered-api.test.ts:26-70` is the suite's whole environment contract. It saves,
overrides and restores `CEZ_HOME`, `HOME`, `CEZ_REMOTE`, `CEZ_DRY_RUN` and `CLAUDE_CONFIG_DIR`; the
last one precisely because a host override would otherwise become the *claude* default. `CODEX_HOME`
is the same class of variable and is simply absent from the list; it was written (`e8fc6d2e`) when
discovery was Claude-only, and D4 of `.ai/specs/2026-08-24-second-codex-account-balancing.md:212-217`
(implemented by `d01fc102`) widened discovery to codex without the suite's env contract widening with it.

The route reads the ambient process env with no test seam:

```ts
// packages/cezar/src/server/server.ts:2940
const discovered = await discoverAgentAccounts();
```

`discoverAgentAccounts` (`packages/cezar/src/workspace/agent-account-identity.ts:190-224`) considers
**each provider's resolved default first**, then `~/.claude*` / `~/.codex*` siblings of `env.HOME`.
The siblings come from the fake `HOME` and are clean; the *default* comes from
`agentHomePaths(env)` (`packages/cezar/src/paths.ts:256-264`), which prefers `CODEX_HOME`. That is
one extra row, always the host's, and it carries the host's identity:

```
+   {
+     "added": true,
+     "configDir": "/var/lib/cezar/.codex-secondary",
+     "identity": { "email": "second@example.com", "plan": "Pro" },
+     "provider": "codex",
+   },
```
(`/tmp/cezar-b3b5719c-control-parent-agent-profiles.log`, 2 failed | 3 passed, at `:109` and `:157`.)

Both failing assertions are exact-shape (`toEqual` on the whole array), which is why this shows up
here first and not in `agent-profiles-api.test.ts`, the same brittleness argument
`.ai/specs/2026-08-22-agent-profile-wiring-cez-kb-test-isolation.md:200-238` made for `CEZ_KB`.

### This is a test defect, not a production defect

Nothing in production is wrong and nothing in production may be narrowed to fix it:

- `CODEX_HOME` taking precedence is a decided, documented relocation boundary
  (`packages/cezar/src/core/agent-profiles.ts:23-45`; KB `specs-4d06fee89bcd`, current).
- Naming the dir cezar *actually* spawns with, not `~/.codex`, is the explicit point of the
  "default first, whatever it is" comment at `agent-account-identity.ts:212-216`.
- The codex half of discovery is D4, deliberate and recent (`specs-d77609665477`), and
  `agent-account-identity.test.ts:318-352` pins it (including a `CODEX_HOME` precedence case at
  `:344-352`). That coverage stays exactly as it is.

### Why one suite's fix is not the whole acceptance criterion

AC2 is about the *gate*, not this file. Audited on this branch, every suite that replaces
`process.env.HOME`:

| Suite | Provider-home overrides | Verdict |
|---|---|---|
| `server/agent-profiles-discovered-api.test.ts:26-70` | owns `CLAUDE_CONFIG_DIR`, **not** `CODEX_HOME` | the defect |
| `server/config-api.test.ts:24-58` | sets `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME` inside the fixture root and restores all three | already isolated |
| `workspace/boot-repo.test.ts:88-104` | owns `XDG_CONFIG_HOME` | already isolated |
| `workspace/agent-accounts-auto.test.ts:45-49` | passes an explicit `env()` object into the sweep, so `process.env` never reaches `agentHomePaths` | isolated by construction |
| `workspace/agent-account-identity.test.ts:319` | same explicit-`env` construction | isolated by construction |
| `server/fs-browse.test.ts:39`, `server/projects-git-init-api.test.ts:275`, `workspace/home-safety.test.ts:79-133`, `server-install/platforms/macosx-ngrok.test.ts:191-267` | none | never call provider discovery |

The route is **not** the only production caller that reaches `process.env`. The boot/interval
auto-registration sweep calls `autoRegisterDiscoveredAccounts()` with no argument
(`server.ts:2466`), and that parameter defaults to `process.env`
(`agent-accounts-auto.ts:69-70`), so the sweep reads the ambient env as well, deliberately, since
a sweep exists to register the logins this machine actually has, provider-home overrides included.
What makes the route suite the only *affected fixture* test is the test side, not the production
side: the auto-registration suite injects its own env object into every call
(`agent-accounts-auto.test.ts:44-49`, `:95`), so `process.env` never reaches `agentHomePaths()`
there. So today the blast radius is one suite, but it is one suite *because* the audit above was
run by hand, and the next `agentHomePaths()`-reading route with a fixture suite re-opens it. `vitest.setup.ts`
already exists for exactly this ("the ambient value nobody chose"), already deletes `CEZ_AUTH` on
those grounds (`packages/cezar/vitest.setup.ts:61-74`), and is the documented first line of defence
in `AGENTS.md:250-300`. It does not yet know about the two provider-home overrides.

One case is deliberately **out of scope**: `server/agent-profiles-api.test.ts:22-53` does not fake
`HOME` at all, so its default-profile rows are genuinely this machine's dirs. Its assertions are
shape-based (`isDefault`, `exists`, `looksValid`) rather than fixture-exact, so it is not a
"fixture-only assertion" in AC2's sense. It must stay green; it is not being rewritten here.

## Solution

**D1. Reconcile with `8219c6f0`; do not re-author the hunk.** Merge `origin/main` into
`cez/6509be16` and confirm the three lines are present. A hand-written duplicate would conflict
with upstream on the next merge, which is the failure `cez/eeceb869` spent two commits undoing
(`125cfe00`, `9c896e32`).

**D2. Production discovery is unchanged.** No edit to `paths.ts`, `agent-account-identity.ts`,
`server.ts`, or `packages/contract/src/agent-profiles.ts`. No test seam is added to the route: the
route reading the real env is the behaviour the pane depends on.

**D3. The scrub moves up to `vitest.setup.ts`, which deletes ambient `CLAUDE_CONFIG_DIR` and
`CODEX_HOME` before any suite in the `server` project runs.** A `delete`, not a sandbox value, on precisely the
`CEZ_AUTH` reasoning at `vitest.setup.ts:61-74`: there is no correct value to substitute, and a
suite that *means* to exercise an override sets it inside its own hook and restores it
(`config-api.test.ts:24-58` already does exactly that, and keeps working: the hooks run after this
file). `XDG_CONFIG_HOME` is deliberately **not** scrubbed: it is not a profile-capable provider's
home, `boot-repo.test.ts:88-104` owns it explicitly, and widening the scrub past the measured
failure class is how a scrub starts hiding real ambient dependence.

This is what makes AC2 structural rather than an audit that goes stale: the per-suite hunk from D1
stays as the second line (`878708f5`'s precedent: the local isolation must be readable without
cross-referencing `vitest.setup.ts`), and the global scrub covers suites nobody has audited yet.

**D4. The API suite grows a codex fixture inside its fake `HOME`.** Answering the brief's open
question 1: clear `CODEX_HOME` (D1) **and** add a `~/.codex` fixture, plus one case asserting a
codex row on the endpoint. Clearing alone leaves the suite Claude-only, so D4's widened contract
would be exercised nowhere at the route level and could silently regress to `provider: 'claude'`
hard-coding, the exact bug `server.ts:2947-2950`'s comment records having already been fixed once.
The fixture is a marker dir (`auth.json`/`config.toml`, per `looksLikeProfileDir`, quoted at
`agent-account-identity.ts:178-180`) written by the suite, never a copy of a real one.

**D5. Correct the suite's stale docblock in the same change.** `:17-23` calls this endpoint "the
Claude logins already on this machine", which the contract contradicts
(`packages/contract/src/agent-profiles.ts:160-186`: "**WIDENED 2026-08-24 from `z.literal('claude')`**").
Answering open question 3: yes, because the workspace rule is that a correction marks what it
invalidates *in place*, and this file is already open.

**Open question 2 (audit every `HOME`-faking suite) is answered by the table in Problem**. The
audit was run, and it found one defect. D3 is what removes the need to re-run it by hand.

## Architecture

```
process env (the runner's)                packages/cezar/vitest.setup.ts
  CODEX_HOME=/var/lib/cezar/.codex-…  ──►  [D3] delete CODEX_HOME, CLAUDE_CONFIG_DIR   ← whole `server` project
  CLAUDE_CONFIG_DIR=/var/lib/…             (alongside the existing CEZ_* / CEZ_AUTH / TMPDIR scrubs)
                                                    │
                                                    ▼
                              agent-profiles-discovered-api.test.ts beforeEach
                                 HOME → temp fixture root      [D1] delete CODEX_HOME (second line)
                                 CEZ_HOME → sibling temp       [D4] write ~/.claude*, ~/.codex fixtures
                                                    │
                                                    ▼
              GET /api/v1/workspace/agent-profiles/discovered   (server.ts:2928-2952, UNCHANGED)
                                                    │
                                     discoverAgentAccounts(process.env)
                                        ├─ agentHomePaths(): CODEX_HOME || $HOME/.codex   (paths.ts:256-264, UNCHANGED)
                                        └─ siblings of $HOME matching .claude* / .codex*  (identity.ts:212-222, UNCHANGED)
```

The only two boxes that change are the two scrubs. Everything below the route is untouched, which is
the property Verification's control has to demonstrate rather than assume.

## Phases

Each phase is independently shippable and independently verifiable.

**Phase 1: reconcile (AC1).** `git merge origin/main` into `cez/6509be16`; resolve conflicts if
any; confirm `packages/cezar/src/server/agent-profiles-discovered-api.test.ts` contains
`codexDir: process.env.CODEX_HOME` (saved), `delete process.env.CODEX_HOME` (beforeEach) and
`['CODEX_HOME', saved.codexDir]` (afterEach). Write no new hunk if they are there. Verified by V1+V2.

**Phase 2: global scrub (AC2).** Edit `packages/cezar/vitest.setup.ts` only: after the `CEZ_AUTH`
delete at `:74`, delete `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, with a comment naming this spec, the
measured failure (`/tmp/cezar-b3b5719c-control-parent-agent-profiles.log`), why it is a delete rather
than a sandbox value, and why `XDG_CONFIG_HOME` is excluded. Verified by V3+V4.

**Phase 3: codex coverage and the stale docblock.** In the API suite only: a `codexDir(name, email?)`
fixture helper writing `auth.json` (a signed-in shape) and/or `config.toml`; one case asserting the
endpoint answers a `provider: 'codex'` row for `~/.codex` in the fixture home, ordered after the
claude rows per `agent-account-identity.ts:212`; and the `:17-23` docblock corrected to name both
providers, citing `.ai/specs/2026-08-24-second-codex-account-balancing.md`. Verified by V1+V5.

**Phase 4: record.** Status log in this spec (what was measured, with the command and the counts),
and a changelog entry in the corpus under a unique title
(`Discovered-account API suite isolated from host provider homes`), followed by
`CEZ_KB=1 cez kb reindex` in `/var/lib/cezar/loki-labs`: a corpus write is not a KB write until the
catalog moves. **Reindexing is not the end of the phase; being findable is.** Prove it:

```bash
cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb reindex
cez kb search "Discovered-account API suite isolated from host provider homes"   # must return the entry
```

**Phase 4 completes when that search returns the changelog entry.** That is the whole exit
condition, and it is entirely within this task's control.

Separately, and as part of this phase's work, append the durable decision ("fixture suites must own
every provider-home override; the `server` project scrubs the ambient pair") as an `upsert` line to
`CEZ_KB_WRITE_FILE`, and note in the status log that the proposal is **filed and pending review**.

Appending it is this task's job; **applying it is not.** A proposal is reviewed and applied later,
by a human, through the cockpit or `cez kb proposals` — never automatically. So the pending
proposal **must not block** Phase 4's completion, nor implementation, commit, push or deploy. Do
not poll for it, and do not hold the task open waiting on it. If a later session wants to know
whether the decision has landed as a durable record, that is answered by `cez kb search` at that
time, not by this task.

## Data Models

None change. `discoveredAgentAccountSchema` / `DiscoveredAgentAccountsResponse`
(`packages/contract/src/agent-profiles.ts:160-186`) keep `provider: providerIdSchema`, `configDir`,
optional `identity`, `added`. Phase 3 adds a fixture that produces a codex row through the existing
shape; it does not extend the shape.

## API Contracts

None change. `GET /api/v1/workspace/agent-profiles/discovered` keeps its current behaviour on every
axis: hosted mode still answers `{ accounts: [] }`, `added` is still the realpath comparison computed
server-side, identity is still absent-when-unreadable rather than `null`, and the resolved provider
default is still listed first even when an override moved it off `$HOME`. The suite's Phase 3 case
asserts that last property against a **fixture** `CODEX_HOME`-free home, never against a host dir.

## Risks

- **R1: the global scrub hides a suite's intended ambient dependence.** Mitigated by scope (two
  variables; `XDG_CONFIG_HOME` excluded), by the audit table above, and by V3 (full gate). Only
  `CODEX_HOME` was measured leaking: it is the variable that produced the recorded failure at
  `:109` and `:157`. `CLAUDE_CONFIG_DIR` is in the scrub for **provider-home symmetry**: it is the
  same class of variable, this suite already isolates it locally (`:26-70`), and a scrub that
  covers one provider's home but not the other's is a trap for whoever adds the third provider. It
  is not there because a second leak was measured. If a suite goes red under Phase 2, it is
  telling us it depended on the developer's own config dir, which is the bug, not the fix; fix it
  locally in that suite, do not narrow the scrub.
- **R2: `vitest.setup.ts` is wired into the `server` project only** (`packages/cezar/vitest.config.ts:18-23`),
  so Phase 2 does not cover `web`, `api-client` or `contract`. Stated rather than fixed: none of them
  can call `discoverAgentAccounts` (it imports `node:fs`), and widening `setupFiles` is a separate
  change with its own blast radius. `AGENTS.md:286-292` already records this same boundary.
- **R3: merge conflicts in Phase 1.** The gap was 17 commits when this spec was first written and
  **23 as of 2026-08-24 22:0x** (`git rev-list --count HEAD..origin/main`); it keeps growing, so
  re-measure rather than quoting either number. What has not changed is the shape: `HEAD` is still a
  direct ancestor of `origin/main` (`git merge-base --is-ancestor HEAD origin/main` succeeds), so the
  merge is a fast-forward, and of the incoming commits only the two codex-related fixes (`03a16af3`,
  `8219c6f0`) touch files this task cares about. Resolve in favour of `origin/main` for the shared
  hunk; this branch has no competing edit to it.
- **R4: re-authoring the duplicate fix.** The brief reported three worktrees carrying this change
  uncommitted; re-measured 2026-08-24, `9bf5030d` and `eeceb869` are clean and `e6592588` carries an
  unrelated `packages/web/src/lib/filed-tasks.ts` edit. The change is *committed upstream* now, so
  Phase 1 must check before it writes.
- **R5: a green focused run that proves nothing.** `CODEX_HOME` is unset in some runner
  environments (it is unset in this one), so the suite passes there with the bug intact. Every
  verification below sets a hostile `CODEX_HOME` explicitly; a run without it is not evidence.
- **R6: `node_modules` is absent in this worktree** (measured). The install must itself be
  env-scrubbed with `TMPDIR` outside the checkout, per `AGENTS.md:250-280` traps 1 and 4, or the
  gate will fail for reasons unrelated to this change.
- **R7: host identity in test output.** The failing run printed a real account's email into the
  diff. Not a new leak (the route is local-only and the reader takes claims, not credentials, per
  `specs-d77609665477`), but it is a second reason the fixture-only property is worth keeping.

## Verification

Run from the task worktree
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/6509be16-c33e-4372-9b8a-5ca862089c49` unless
stated. Install first (R6):

```bash
scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
tmp=/tmp/cez-gate-$$ && mkdir -p $tmp
env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm ci
```

Every focused invocation below goes through `npm test -- <path>`, never `npx vitest`: vitest is a
devDependency here and `npx` will reach past the pinned binary to the registry
(`AGENTS.md:239-248`).

- **V0: the control, run BEFORE Phase 1, so the fix is not credited to the weather.**
  `CODEX_HOME=/var/lib/cezar/.codex-secondary npm test -- packages/cezar/src/server/agent-profiles-discovered-api.test.ts`
  → expect **2 failed | 3 passed**, failing at `:109` and `:157` with a
  `/var/lib/cezar/.codex-secondary` row, reproducing
  `/tmp/cezar-b3b5719c-control-parent-agent-profiles.log` on demand. If this passes, stop: the
  premise is not reproducible here and the spec needs re-measuring, not implementing.
- **V1: AC1, hostile codex home.** V0's exact command again. The expected count is
  **phase-specific**, because Phase 3 adds a sixth test to this file: immediately after Phase 1 →
  **5 passed**; after Phase 3 → **6 passed**. Repeat each with `CODEX_HOME=/var/lib/cezar/.codex`
  (the other real host profile) for the same count.
- **V2: AC1, both overrides hostile at once.** The exit code is checked separately from the output
  scan, so a failing suite can never be read as a clean one:

  ```bash
  log=/tmp/cez-v2-$$.log
  CLAUDE_CONFIG_DIR=/var/lib/cezar/.claude-secondary CODEX_HOME=/var/lib/cezar/.codex-secondary \
    npm test -- packages/cezar/src/server/agent-profiles-discovered-api.test.ts >"$log" 2>&1
  echo "EXIT=$?"                                                  # must be 0
  rg -n '/var/lib/cezar/\.(codex|claude)' "$log"; echo "RG=$?"    # must print nothing, RG=1
  tail -20 "$log"                                                 # read the count off this
  ```

  **Both** conditions are required. `EXIT=0` is the suite passing; `RG=1` is ripgrep's no-match
  exit, so `RG=0` means a host profile path reached the suite's output and V2 has failed even if
  `EXIT` was 0. The count in `$log` is phase-specific exactly as in V1: **5 passed** after Phase 1,
  **6 passed** after Phase 3. Re-run this command unchanged as the final hostile-environment pass
  once Phase 3 has landed.
- **V3: AC2, the whole gate under a hostile environment.**
  `CLAUDE_CONFIG_DIR=/var/lib/cezar/.claude-secondary CODEX_HOME=/var/lib/cezar/.codex-secondary env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm test`
  → green, with the file/test counts recorded in this spec's status log. This is the criterion's
  actual wording: the gate must not include host agent accounts even when the host has set both
  variables.
- **V4: Phase 2 is not vacuous.** With Phase 2 applied and Phase 1's local hunk temporarily
  reverted in the working tree, V1's command must still answer V1's phase-appropriate count (5
  before Phase 3, 6 after), since the global scrub alone carries it; restore the hunk immediately
  afterwards and re-run V1. Records that the two lines of
  defence are genuinely independent rather than one line counted twice.
- **V5: Phase 3 coverage is real.** The new codex case must fail when
  `agent-account-identity.ts`'s codex branch is stubbed to return no rows (a scratch edit, reverted):
  a fixture case that passes with codex discovery disabled is testing nothing.
- **V6: the rest of this repo's gate.** There is **no `lint` script in this repo** (checked), and
  neither the root `package.json` nor any workspace package defines one, so do not run
  `npm run lint`. The gate is the five commands in `.ai/agentic.config.json`'s
  `validation.commands`; V3 covers `npm test`, and the other four run here, in this order, under
  the same scrubbed env and `TMPDIR` as the install block above:

  ```bash
  env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run typecheck \
    && env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run test:unit \
    && env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run build \
    && env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run test:package
  ```

  The order is not cosmetic: `npm run test:package` packs and installs the release tarball and so
  needs the completed `npm run build` (`AGENTS.md:230-237`).
- **V7: no runtime E2E is indicated, and this is a deliberate claim, not an omission.** The change
  touches test files and `vitest.setup.ts` only; no shipped code path, no UI, no wire format moves.
  Nothing in `.ai/specs/` requires a device or runtime pass for a fixture-isolation change (searched;
  not found). The user-facing behaviour this suite guards, the Add-account pane listing this
  machine's logins, is unchanged by construction under D2, and V2's "no host path in the output"
  check is what would catch it if that were untrue.

## Status log

- **2026-08-24, implementation step:** `npm ci` completed with exit 0 under the prescribed
  environment scrub. V0 reproduced the original defect with `CODEX_HOME=/var/lib/cezar/.codex-secondary`:
  2 failed and 3 passed, with the host account row at the two exact-list assertions.
- **2026-08-24, Phase 1:** Fast-forwarded `cez/6509be16` to `origin/main` at `e38cb619`, which
  supplied the existing per-suite `CODEX_HOME` save, clear, and restore hunk. No duplicate hunk was
  authored.
- **2026-08-24, Phase 2:** Added the server-project scrub for `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
  V4 temporarily removed the Phase 1 hunk and still passed 6 focused tests under both hostile
  provider overrides, proving the global scrub is independent. The hunk was restored immediately.
- **2026-08-24, Phase 3:** Added a synthetic Codex `auth.json` fixture and an exact API assertion for
  the existing Claude-then-Codex ordering. The focused test passed 6/6 with each hostile Codex home,
  with both hostile provider homes, and after restoring the Phase 1 hunk. V2's host-path scan found
  no `/var/lib/cezar/.codex` or `/var/lib/cezar/.claude` path in the output.
- **2026-08-24, Phase 4:** Added the corpus changelog entry titled
  `Discovered-account API suite isolated from host provider homes`, reindexed the corpus, and
  confirmed the title is searchable. Filed the durable provider-home isolation decision as a KB
  proposal, pending review. The full hostile root gate and V6 validation commands remain for the
  later authoritative test step; no runtime E2E is indicated because shipped behavior and the wire
  contract are unchanged.
