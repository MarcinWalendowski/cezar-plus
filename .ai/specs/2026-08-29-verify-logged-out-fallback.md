# Verify the Logged-Out Fallback

- **Status:** Written 2026-08-29 for run `55e9d5df-a9da-4d04-a1d1-ef107cea4842`
  (`spec-to-deploy`), step 2 of 9; **revised twice on 2026-08-29, after two reviews**. **Nothing here has been
  executed.** No gate, no E2E, no deploy and no record edit has been performed by this step; every
  number below is a measurement, and every command below is a proposal.
- **Revision 2026-08-29 (second review).** Nine more findings, all against current `origin/main`,
  all applied and each marked `CORRECTED 2026-08-29 (second review)` where it landed. Two were
  blocking execution mismatches: the per-account status route answers `{status: {…}}`, so P2's
  `.status == "connected"` was false on a correctly staged fixture (`server.ts:3312-3326`); and the
  waitable case could not become waitable from a `pool:*` route at all, because `credentialTier` is
  two-valued, `notePoolSkip` runs before any hold exists, and `accountHolds().deadline` is built
  from failed run records rather than from `agent-account-usage.json`, so it is now staged on the
  explicit default and asserts `site: "explicit-reroute"`. Four were missing or wrong fixture
  mechanics: the tree creation lost with the deviation (`$REPO`, `git init`, `$REPO_REAL`,
  `$CREDS/bin`, `$CREDS/codex-config`, `$CREDS/home/.cezar`), a step 6 that said "poll" instead of
  polling, a browser session the trap did not actually close, and a non-interference baseline that
  watched two of this box's four live credential homes. Two were record problems: the proposal's
  `seq` was hard-coded to `0`/`1` while `NEXT` was computed beside it, and P3 branched on "if the
  proposal can be applied", which has no true arm, so the phase is renamed to proposal-plus-handoff
  and criterion 4 is a stated blocker. The last is this document's punctuation, below.
- **Revision 2026-08-29 (review).** Nine findings, all against current `origin/main`, all applied.
  Six were plans that could not have executed: the project route and body were wrong
  (`POST /projects`, `{"root": …}`, not `POST /workspace/projects` with `path`); the run and
  run-record responses were read as `{run}` envelopes when both are raw records; `/runs/:id/events`
  was read as finite JSON when it is an indefinite SSE stream; the fixture staged an **explicit
  account**, which exercises `explicit-reroute` rather than the `pool:*` route criterion 5 names;
  the browser check ran **after** the server it targets was stopped; and both provider shims
  lacked the `--version` branch that `GET /health` fires at them. Three were evidence problems: W3
  inspected shim logs the test deletes in its own `finally` and named four tests that do not exist
  as tests; W6 gated on a byte-identical `providers/status` on a shared live box; and P3 corrected
  a mounted KB document by editing it, which the active knowledge-base rule forbids. P0 also gained
  the worktree synchronization the phases silently assumed. Each is marked `CORRECTED 2026-08-29
  (review)` at the section it changed, with what the wrong version would have done.
- **Date:** 2026-08-29
- **Repo:** `cezar`. Spec authored in worktree
  `.ai/cezar/worktrees/55e9d5df-a9da-4d04-a1d1-ef107cea4842`, HEAD `2fd01a16`, which is **stale**:
  it predates the feature and does not contain the files this spec is about. Every code citation
  below is against `origin/main`, read with `git show origin/main:<path>`, and says so.
- **Task:** `55e9d5df-a9da-4d04-a1d1-ef107cea4842`, "Land and deploy the logged-out account
  fallback (PR #11, branch cez/90836867)". Tracker todo
  `21e18103-dd69-41de-8343-b6d401df75db` (`[high, started]`, confirmed live in `cezar todo list`).
- **Brief:** `.ai/specs/briefs/2026-08-29-logged-out-fallback-landing.md`, written by step 1 of
  this run. Read in full. Its central judgement holds and is the reason this spec exists in the
  shape it does: the landing already happened, so the task's own context is stale. Three of its
  claims are re-measured and moved below, one of its open questions is **answered from shipped
  code** rather than escalated, and one thing it did not check turns out to remove a whole phase
  of work. All four are marked in Measured facts.
- **Ships and verifies, does not reopen:**
  `.ai/specs/2026-08-25-logged-out-account-fallback.md` (on `origin/main`). That spec owns the
  design, the three-tier contract, the message copy and the definitions of V1 through V8. This
  spec does not re-specify any of it and changes no behaviour. It owns exactly one thing: getting
  the feature from "merged and running, unproven" to "proven, with the record saying so".
- **Reads against:** `.ai/specs/2026-08-24-manual-deploy-not-a-bug.md` (a parked deploy step is
  the expected terminal state, not a failure), `.ai/specs/2026-08-26-activate-main-not-worktrees.md`
  (one activation of `origin/main` clears every parked run), `.ai/specs/2026-08-24-default-workflow-ten-stages.md`
  D6 (both deploy targets are `manual: true`, owner decision), `.ai/specs/2026-08-24-config-api-env-isolation.md`
  (commit `fe4287c2`, the fix for the failure this task's context still calls open),
  `.ai/specs/2026-08-25-disposable-e2e-fixture-containment.md` (an E2E fixture that escapes its own
  cleanup is a production incident), `.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md`
  (a probe that cannot fail is not a probe), KB `notion-eb0154f0fbb7` (the decision: viability is
  per account, not per provider), KB `notion-3979979f15e0` (the corpus changelog this spec must
  correct in place).
- **Punctuation note. CORRECTED 2026-08-29 (second review).** This bullet used to claim "nothing in
  this spec's own prose uses one", and that was simply false: 56 em dash characters were in the
  document when it was reviewed, throughout the prose and not only in quotations. They are gone.
  Workspace doctrine forbids the character in anything written here, with no quotation exemption,
  so the few places that quoted a source comment or an existing document verbatim are
  **re-punctuated** rather than byte-exact. Where the exact original wording matters, the file and
  line are cited beside it and are the thing to read.

---

## TLDR

**The task asks for work that is already done, and does not ask for the work that is actually
left.** Measured on the box today:

- PR #11 is **MERGED**, as `c569aee8` at 2026-08-25T12:59:13Z, from branch `cez/90836867`.
- The feature is **already deployed and running in production**. The live release is
  `20260829T110133Z-a04cda25`, sha `a04cda2591378edc96e155978df672238b5fe9a3`, activated
  2026-08-29T11:01:38Z. Both `c569aee8` and the shipped branch tip `d385cd5c` are **ancestors** of
  that sha, so the fallback code is what the running server is executing right now.
- The `config-api.test.ts` failure the task context asks us to hold harmless was not merely
  pre-existing, it has since been **fixed on main** by `fe4287c2`.

So three of the five acceptance criteria are satisfied by facts that predate this run, and saying
so is the honest answer rather than re-doing them. What is genuinely outstanding is the half the
feature spec itself flagged and refused to round up: **V6 and V7 have never run, so the change is
`QA Needed` and the record still says "not yet deployed", which is now false in the other
direction.**

Two findings change the size of that remaining work, both from reading the shipped code rather
than the brief:

1. **V7 does not need writing. It is already written and it already ships.**
   `packages/cezar/test/e2e/package-cli.test.ts` on `origin/main` carries all four of V7's
   headless cases, with the argv-branching codex shim, the packed mock app-server, and the exact
   stderr assertions. Executing V7 is running `npm run test:package` and quoting the result, which
   is already gate 5 of the required sequence. V7 collapses into the gate phase.
2. **V6 as written cannot be executed on this box, and its central safety guard fails open.** It
   requires a `CODEX_FIXTURE_HOME`, "a dedicated Codex home that exists on the box for this
   purpose". No such home exists: the box has exactly two codex homes and the live service uses
   **both**. Worse, V6's guard compares the fixture against a single operator-supplied
   `LIVE_CODEX_HOME`, so on a two-home box it passes while pointing the test at live credentials,
   which is the exact accident it exists to prevent. The fix is not to provision a third login. It
   is to use the technique the shipped V7 test already uses and which V6 was written before anyone
   had: `CEZ_CLAUDE_BIN` / `CEZ_CODEX_BIN` override the executable for **both** the auth probe and
   the runner, so a connected account can be staged with a shim and **no credential is read, copied
   or touched at all**. That is a declared deviation from V6 step 4, argued below, and it makes V6
   strictly safer than the version it replaces.

The plan is four phases: pin a revision and re-measure (P0), run the full five-gate sequence twice
on it, which executes V7 (P1), run V6 against an isolated secondary server with shim-staged
credentials and retained artifacts (P2), then correct the record in place and close the todo (P3).
No phase activates a deploy: both targets are `manual: true` and a person does that, not an agent.

---

## Problem

### P-A. Three acceptance criteria describe work that already happened

The task's Context paragraph is a faithful account of the world on 2026-08-25 and is stale in
every particular that matters. Re-measured 2026-08-29:

| Acceptance criterion | Measured state |
| --- | --- |
| origin/main merged into the branch, full gates on the merged tree | Merged. `c569aee8`, PR #11, 2026-08-25T12:59:13Z. Gates ran on the merged revision `d385cd5c` (`npm ci`, `npm run typecheck`, `npm test`: 631 files / 11911 tests, 0 failing). Three of the five required gates, on a revision that is no longer the tip. |
| V6 and V7 executed and quoted | **Not done.** No artifact, no quoted output, no evidence anywhere in the repo or corpus. |
| `config-api.test.ts` confirmed pre-existing, not caused by this branch | Better than that: **fixed** on main by `fe4287c2` (`.ai/specs/2026-08-24-config-api-env-isolation.md`). Todo `541c8214` is still open in the tracker and is about the underlying model-default question, not about this branch. |
| PR #11 merged and the change deployed | Both done. Live release `20260829T110133Z-a04cda25`. |
| A real dispatch proves the symptom is gone | **Not done**, and the naive reading of it is destructive. See P-C. |

Re-doing the merge is impossible and re-running a gate on `d385cd5c` proves nothing new. The
criterion behind the first row, though, is still live and worth honouring in its strongest
available form: **the tree a person would activate next has never had the full five-gate sequence
run on it.** That is what P1 does.

### P-B. The change is `QA Needed` by its own spec, and the record says something different

`.ai/specs/2026-08-25-logged-out-account-fallback.md:3-8` is explicit:

> **V6** (the isolated-secondary-server runtime E2E) and **V7** (the packed-CLI E2E) below have not
> run, and the change has not been deployed. Do not read this as `Implemented` until V6, V7 and the
> deploy have actually happened.

Half of that sentence is now false. The deploy happened. V6 and V7 still have not. Meanwhile the
corpus changelog `notion-3979979f15e0` opens with a bolded

> **Fixed and merged to main; not yet deployed.**

which is the claim a reader takes away from scanning it, and it is wrong today. Doctrine here is
unambiguous: a correction marks what it invalidates **in place**, amending the heading when the
falsehood is in the heading. Both documents need editing, and neither may simply gain an appended
paragraph.

### P-C. The "real dispatch" criterion, read naively, breaks production

The fifth criterion asks for a dispatch on the box "with one account logged out". The box has two
profile-capable accounts and both are in live use:

```
secondary                      claude   /var/lib/cezar/.claude-secondary   owner@example.com
second-example-com   codex    /var/lib/cezar/.codex-secondary    second@example.com
defaults: { "claude": "pool:*", "codex": "pool:*" }
```

Logging one out is destructive twice over, and the feature spec already ruled on it
(`:2028-2036`): the running service is executing other people's tasks and revoking its credentials
fails every one of them, and an exported `CLAUDE_CONFIG_DIR` does not reach an already-running
systemd unit anyway, so the "broken" state would be invisible to the process under test and the
E2E would pass on a machine that was never actually broken.

**This spec rules that V6 step 6 IS the criterion's dispatch proof**, staged on an isolated
secondary server rather than by breaking the live one. It is the same assertion (a `pool:*` route,
claude disconnected, codex viable, the run starts on codex and no claude process is ever spawned)
against the same binary, with the live service provably untouched by a before/after diff. A proof
that requires an outage to obtain is not a stronger proof.

### P-D. V6 step 4 is unsatisfiable here, and its guard fails open

V6 step 4 requires two operator-supplied variables and hard-stops without them:

```sh
: "${CODEX_FIXTURE_HOME:?set CODEX_FIXTURE_HOME to a DEDICATED codex home (never the live service's)}"
: "${LIVE_CODEX_HOME:?set LIVE_CODEX_HOME to the codex credential dir the LIVE cezar service actually uses}"
test "$(realpath "$CODEX_FIXTURE_HOME")" != "$(realpath "$LIVE_CODEX_HOME")" \
  || { echo "refusing to use the live service's codex home"; exit 1; }
```

Measured on `prod-host`: the only codex homes that exist are `/var/lib/cezar/.codex` (the
discovered default) and `/var/lib/cezar/.codex-secondary` (the registered account). There is no
third, dedicated one. So:

- **The hard stop fires.** V6 is not executable today, and the spec is explicit that this "is not
  satisfiable by inventing a credential file".
- **The guard is defeatable.** `LIVE_CODEX_HOME` is scalar and the box has **two** live codex
  homes. Declaring `LIVE_CODEX_HOME=/var/lib/cezar/.codex-secondary` and pointing
  `CODEX_FIXTURE_HOME` at `/var/lib/cezar/.codex` passes the inequality check while aiming the
  test squarely at a live credential directory. The guard was written against a one-home model of
  the box and **fails open** on the real one, which is the same defect class the guard's own
  comment complains about in the draft before it.
- Even a correct comparison would not make the copy safe. `cp -a` of a codex home carries a
  refresh token; a second process that refreshes it can invalidate the original, so "we only
  copied it, we did not use theirs" is not the safety property it sounds like.

### P-E. What the brief could not settle, settled from code

The brief's open question 2 asks whether the dedicated Codex fixture home and the live Codex home
are available for V6, and correctly says the spec makes absence a hard stop rather than a
fabricated fixture or a skip. Both halves of the premise are now answered:

`CEZ_CLAUDE_BIN`, `CEZ_CODEX_BIN` and `CEZ_OPENCODE_BIN` override the provider executable at
**every** layer the E2E cares about, on `origin/main`:

- the auth descriptor, so the probe runs the shim:
  `packages/cezar/src/core/provider-auth.ts:233-250`
  (`executable: () => process.env.CEZ_CODEX_BIN ?? 'codex'`, `statusArgs: ['login', 'status']`);
- the per-account probe: `packages/cezar/src/core/agent-account-probe.ts:371,463`;
- backend detection: `packages/cezar/src/core/backend-detect.ts:35,68,87`;
- and the **runners**, so a dispatch also lands on the shim:
  `packages/cezar/src/core/claude-cli-runner.ts:136` and
  `packages/cezar/src/core/codex-app-server-transport.ts:34`
  (`override ?? process.env.CEZ_CODEX_BIN ?? (CEZ_DRY_RUN ? mockCodexPath() : 'codex')`).

The shipped V7 test uses exactly this, and its comment says why it is the right fixture rather than
a convenience (`package-cli.test.ts:278-286`): under `CEZ_DRY_RUN` every auth read short-circuits
to connected, so a disconnected account is unstageable and the case would pass vacuously; the shim
is "the subprocess-visible fixture the auth layer actually consults".

That answers the question the guard was protecting. V6's stated reason for demanding a real
credential is that "`connected` cannot be faked by a file whose shape we guessed, because the
provider CLI decides". With `CEZ_CODEX_BIN` set, the shim **is** the provider CLI that decides.
Nothing is guessed and nothing is faked at a layer that cannot see it. V6 step 5 already shims
`claude` for the same reason; this extends the technique it already relies on to the other half of
the fixture, and deletes the only step that required a live credential to exist.

---

## Measured facts

Every command was run read-only from this worktree or against the live box, 2026-08-29. Nothing
below was inferred.

**M1. PR #11 and its ancestry.**

```
$ gh pr view 11 --json state,mergeCommit,mergedAt,headRefName
{"headRefName":"cez/90836867","mergeCommit":{"oid":"c569aee8178e71bfff8cfe45e05e3202555adae4"},
 "mergedAt":"2026-08-25T12:59:13Z","state":"MERGED"}
```

`c569aee8`, `d385cd5c` and `b18c0cbc` are all ancestors of `origin/main`.

**M2. The live release, and the fact that decides this spec's scope.**

```
$ curl -fsS http://127.0.0.1:4321/api/v1/ready
{"ready":true,"version":"0.10.0", ... ,"deploy":{"releaseId":"20260829T110133Z-a04cda25",
 "version":"0.10.0","sha":"a04cda2591378edc96e155978df672238b5fe9a3",
 "activatedAt":"2026-08-29T11:01:38.376Z","builtAt":"2026-08-29T11:01:33.102Z","dirty":false}}

$ git merge-base --is-ancestor c569aee8 a04cda25 ; echo $?   # 0
$ git merge-base --is-ancestor d385cd5c a04cda25 ; echo $?   # 0
```

**The feature is in production.** `a04cda25` is "fix: Resolve answers a red recheck, and a park can
be cleared at all".

**M3. `origin/main` has moved past the live release, and moved during this step.** The brief
measured `2f0a50b2`; it read `17637629` an hour later. `17637629` is **not** an ancestor of the
live sha: main is two commits ahead of production (`28c5513b`, "sweep every project's manual-deploy
parks after a restart", plus its merge). Neither touches the fallback. Treat the tip as a reading,
not a constant, and pin it in P0.

**M4. V7 is already implemented and already gated.** `packages/cezar/test/e2e/package-cli.test.ts`
on `origin/main` is 520 lines and carries the V7 block from `:278` to `:519`, labelled
`// V7: the headless CLI shares the fallback decision, at package level`. It contains all four
substantive cases with their exact assertions:

- healthy fallback (`:398-425`): `CEZ_CLAUDE_BIN=claude-disconnected`, `CEZ_CODEX_BIN=codex-healthy.sh`,
  asserts `doesNotMatch(/credentials are unavailable|No agent provider is authorized/)`, that codex
  was **probed and run** (both logs non-empty), and that the shim never took an unrecognised branch;
- no connected account (`:427-450`): exits non-zero, stderr **exactly** `NO_PROVIDER_AUTHORIZED_MESSAGE`;
- connected but out of scope (`:452-489`): explicit claude route, `fallbackAcrossAccountsWhenLimited: false`,
  stderr exactly `fallbackOffMessage('claude')`;
- connected but nothing eligible (`:491-517`): opencode connected, stderr exactly
  `noEligibleFallbackMessage('claude')`.

The codex shim branches on argv and `exec`s `packages/cezar/scripts/mock-codex-app-server.mjs`,
which `check-pack` requires in the tarball, so it is reachable from the packed artifact.

**M4a. V7's healthy-fallback case has a stated, deliberate limit**, and this spec does not treat it
as a defect (`package-cli.test.ts:380-396`): it proves the preflight did not refuse and that
dispatch was actually attempted on codex, **not** that the run completes. The JSON-RPC turn stalls
after the first tool call in that harness. The comment names where completion is proven instead:
`workspace/account-viability.test.ts` and `server/provider-action-gating.test.ts:622`, the case
literally named `THE REPORTED BUG: pool:*, fallback off, claude wholly logged out, codex healthy → 201`.
V6 is what closes the remaining gap at runtime.

**M5. The box's accounts and codex homes.** As quoted in P-C and P-D:
`/var/lib/cezar/.cezar/agent-accounts.json` holds `secondary` (claude) and
`second-example-com` (codex), both defaults `pool:*`, `selections: {}`. The only codex
homes on disk are `/var/lib/cezar/.codex` and `/var/lib/cezar/.codex-secondary`. The unit runs
`User=cezar` and declares only `Environment=CEZ_CLUSTER=1`.

**M6. A browser is present, but it is not Playwright. CORRECTED 2026-08-29 (review), and this
changes what the browser step (P2 step 7, formerly step 10) can produce.** The original measurement stands and is left below; what was
wrong is the conclusion drawn from it. Re-measured against `origin/main`:

- **Playwright is not a dependency of this repository.** `git grep playwright origin/main --
  package.json packages/*/package.json` returns **nothing**, and `node_modules/@playwright` and
  `node_modules/playwright*` do not exist. A step that says "raw Playwright" is therefore not
  executable here, whatever is in the browser cache.
- **The repo's browser seam is `agent-browser`**, named in `.ai/agentic.config.json`
  (`"browser": {"provider": "agent-browser"}`), contracted in `.ai/browsers/agent-browser.md`, and
  wrapped for the e2e specs by `packages/web/e2e/agent-browser.ts`. The binary is installed:
  `/var/lib/cezar/.cache/agent-tools/agent-browser/agent-browser-linux-x64` (13.9 MB, 2026-08-21),
  and `--help` runs, listing `open`, `fill`, `press`, `screenshot`, `snapshot`, `eval`, `get`,
  `is`, `close`.
- **It has no video capability.** `agent-browser screenshot --help` offers `--full`, `--annotate`,
  `--screenshot-dir`, `--screenshot-quality` and nothing else; there is no `record`/`video`
  command. So `recordVideo` and a `video/` artifact are withdrawn from the browser step and from
  W4. The
  artifacts it can actually produce are a **screenshot**, an **accessibility snapshot**, and the
  `eval`'d composer state, which is exactly what every `packages/web/e2e/*.e2e.ts` spec in this
  repo asserts on.
- **`.ai/qa/test-env.json` does not exist on this box**, so `AgentBrowser.open()` (which reads it
  for `browser.command`) cannot be used as-is. Step 10 invokes the cached binary by absolute path
  instead, which is what that descriptor would have pointed at anyway.

Original text, unchanged: ~~**M6. Browsers are present**, so V6 step 10 is not a skip:
`/var/lib/cezar/.cache/ms-playwright/` holds `chromium-1234`, `chromium_headless_shell-1234` and
`ffmpeg-1011`, the last of which is what records the video the step requires.~~ (The cache is real:
`agent-browser` ships its own Chrome for Testing, and the ms-playwright cache belongs to
something else on this box. Its presence proves a browser exists, not that this repo can drive one
with Playwright.)

**M7. Deploy is manual, by owner decision, and this spec obeys it.** Both targets in
`.ai/deploy-targets.json` carry `"manual": true` and a `manualReason` naming
`bash scripts/activate-main.sh`, run as `cezar` and never as root. An agent does not activate
cezar. A red deploy probe with a handoff attached is a park awaiting a human
(`.ai/specs/2026-08-24-manual-deploy-not-a-bug.md`), not a failure to be worked around.

**M8. The required gate sequence has five members and no lint gate**
(`.ai/specs/2026-08-25-logged-out-account-fallback.md:1983-1993`, cross-checked against the root
`package.json` `scripts` block on `origin/main`): `npm run typecheck`, `npm test`, `npm run test:unit`,
`npm run build`, `npm run test:package`. There is no `lint` script and none is invented here.

**M9. The corpus corrections needed.** `notion-3979979f15e0`
(`notion-export/changelog/2026-08-25-account-fallback-instead-of-blocking-dispatch--local.md`) has
a stale bolded lead-in (`**Fixed and merged to main; not yet deployed.**`) and a closing paragraph
(`Still open: the deploy, and the spec's live on-box V6 and V7 checks.`). Its earlier
`**CORRECTED 2026-08-25.**` block already handled the landing half correctly and is the model to
follow. The knowledge note `notion-eb0154f0fbb7` states the decision and needs no correction; it is
cited, not edited.

**M10. What could not be verified in this step.** No V6 or V7 artifact exists anywhere in the repo,
the corpus or `/var/tmp`, so "has V6 ever run" is answered by absence of evidence rather than by a
negative record. This spec ran no gate, so the claim that the pinned tree is green is **not** made
here; P1 makes it or fails.

---

## Solution

Do the outstanding half, and correct the record so the next session does not re-derive any of this.

1. **Pin the revision** at the start, so every later claim names one sha. Gate the pinned
   `origin/main`, not this run's worktree and not `d385cd5c`: main is what `activate-main.sh`
   deploys, so it is the tree whose greenness a human actually needs, and it contains `c569aee8`,
   `d385cd5c` and whatever release is live. **The live release id is measured, never quoted from
   here:** it was `20260829T110133Z-a04cda25` when this spec was written and
   `20260829T111523Z-17637629` (sha `176376293522fc5be915fe60713c9ea5cd7df3c3`, activated
   `11:15:27Z`) at review time, twelve minutes later, and `d385cd5c` is an ancestor of both. P0
   reads it and every later phase uses `$LIVE_RELEASE`.
2. **Run the five gates, twice, environment-scrubbed.** Gate 5 is V7, so V7 is executed and quoted
   as a by-product rather than as separate work. `CEZ_DRY_RUN` and `CEZ_AGENT_MODELS_LOCKED` must
   be **unset**, or V7's disconnected fixtures become unstageable and four cases pass vacuously.
3. **Run V6 with shim-staged credentials and a `pool:*` selection**, following the feature spec's
   steps 1, 2, 3, 5, 6, 7, 8, 9 and 10, replacing step 4's credential copy with `CEZ_CODEX_BIN` /
   `CEZ_CLAUDE_BIN`, and **running the browser case before teardown rather than after it**. Nothing
   under the live service's `CEZ_HOME` is written; the evidence is the live release id, the service
   pid and the live stores' hashes, unchanged across the phase (the `providers/status` diff is kept
   as a diagnostic, not as a gate; see W6).
4. **Correct the record as far as this run can, and hand off the rest**: the feature spec's status
   block edited in place, and the corpus changelog corrected through a `$CEZ_KB_WRITE_FILE`
   proposal (never by editing the mounted document), then reindex, because on this box a corpus
   write is not a knowledge-base write until `cez kb reindex` runs. **The proposal cannot be
   applied by this run**, on `origin/main` there is no apply path and the target is a read-only
   mount, so acceptance criterion 4 ends as a reported blocker with todo `21e18103` open. See P3(c).
5. **Do not deploy.** The feature is live. If the run's own commit needs activating, that is a park
   and a human's `bash scripts/activate-main.sh`.

### Declared deviation: V6 step 4

**What changes.** `CODEX_FIXTURE_HOME` and `LIVE_CODEX_HOME` are dropped. The connected half of the
fixture is a codex shim on disk, selected with `CEZ_CODEX_BIN`, branching on argv exactly as
`package-cli.test.ts:317-344` does. The disconnected half stays what it already was, an empty
config dir under an `env -i` launch, reinforced with `CEZ_CLAUDE_BIN` pointed at a shim that
refuses.

**Why it is not a weakening.**

- It touches **zero** live credentials, where step 4 as written copies one. That is strictly safer,
  and it removes the failure mode P-D describes, in which a scalar guard on a two-home box aims the
  test at production credentials while reporting that it refused to.
- It is the fixture the same feature spec already accepts for the same decision, one section later,
  for the same reason. V7's shim decides `connected` for the auth layer, and V7 is the spec's own
  package-level proof of the same contract.
- The property under test is the **selection decision**, not credential parsing. `assessAccountViability`
  reads a cached auth row; what wrote that row is the probe, and the probe is what the shim answers.
- It removes an operator prerequisite that does not exist and cannot be conjured, converting V6
  from unexecutable to executable without lowering a single assertion.

**What it costs, stated rather than hidden.** The E2E no longer proves that a genuine codex login
parses as connected. That is provider-CLI behaviour, not this feature's, and it is exercised
continuously by the live service. Every assertion V6 makes about tiers, selection, held runs,
refusal strings and "no run on the dead login" is unaffected.

**The feature spec must be corrected in place** for this, in P3, since a reader of V6 must not
carry away a prerequisite that was withdrawn. Marked `CORRECTED 2026-08-29`, original text kept
below the lead-in.

---

## Architecture

### What is being verified, and where each claim is proven

```
  claim                                     proven by            layer
  ----------------------------------------  -------------------  -----------------------
  tiering: runnable/waitable/disconnected   account-viability     unit (already green)
  gate agrees with picker on pool:*         provider-action-      HTTP route
                                            gating.test.ts:622
  headless CLI shares the decision          package-cli.test.ts   packed artifact  = V7
  a real server dispatches around a         V6 steps 6, 8, 9      running process  = V6
  logged-out account, holds a waitable
  one, refuses only when honest
  the composer is not client-side blocked   V6 step 7             browser (agent-browser)
  production was not disturbed              V6 steps 2 and 10     release id, pid, store hashes
```

V6 is the only row with no coverage today, which is why it is the phase with the most detail.

### Isolation, and the three trees

V6 runs a **second** cezar process beside the live one, on port `47311`, launched by absolute path
under `env -i`, with three separate directories and only one of them retained:

- `$ART` (`/var/tmp/cez-e2e-art.XXXXXX`), **retained**: logs, pids, json, png, the artifact sha,
  `live-before.json` and `live-after.json`. No video: `agent-browser` cannot record one (M6).
- `$CREDS` (`/var/tmp/cez-e2e-creds.XXXXXX`), **removed by the trap**: the scratch `CEZ_HOME`, the
  scratch project repo, and the shim directory.
- The live service's `CEZ_HOME` and `/opt/cezar`, **never written**, and read exactly twice: the
  before and after snapshots of `GET /providers/status`, without `?refresh=1` so the read does not
  make the live process spawn probes.

`env -i` is what makes the isolation real rather than asserted: it is the only way to be certain
the secondary did not inherit `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or a `CEZ_*` from the shell and
quietly read the live credentials. The trap is armed **before** the first fixture is written, is
pid-guarded so an empty `$SRV` cannot become `kill 0` against the operator's own process group, and
is called explicitly at the end and then disarmed, so teardown is observable while the script is
still running.

`.ai/specs/2026-08-25-disposable-e2e-fixture-containment.md` is the reason `$CREDS` is separate
from `$ART` and the reason the cleanup is not an afterthought: a fixture that escapes its own
cleanup on this box has previously become a production incident.

---

## Data models and API contracts

None of these are introduced here. They are the shapes P2 writes and asserts against, quoted from
`origin/main` so the phase does not have to guess them.

**`$CEZ_HOME/agent-accounts.json`** (`packages/cezar/src/workspace/agent-accounts.ts:94-176`,
path from `paths.ts:122-124`). `id` matches `/^[a-z0-9][a-z0-9-]{0,63}$/` and may not be the
reserved `default`; `provider` must be profile-capable (`claude` or `codex`); `selections` is keyed
by the project's **realpath'd** root.

```json
{ "version": 1,
  "accounts": [{ "id": "codex-fixture", "provider": "codex",
                 "configDir": "<CREDS>/codex-config", "label": "e2e codex",
                 "addedAt": "2026-08-29T00:00:00Z" }],
  "defaults": {},
  "selections": { "<REPO_REAL>": { "claude": "pool:*", "codex": "codex-fixture" } } }
```

**The claude selection is `pool:*`, and that is the whole point of the fixture.** An earlier draft
of this section wrote `"claude": "default"`, which stages an **explicit account** route: the run
would then take `rerouteExplicitAccountIfUnavailable` and emit a metric with
`site: "explicit-reroute"` (`run.ts:3263-3274`), proving a different code path from the one the
acceptance criterion names. `pool:*` is the reserved spelling in
`packages/contract/src/agent-route.ts` (`AGENT_POOL_ALL`, `:37`), and `parseAgentRoute` (`:73-81`)
maps it to `{kind: 'pool'}` with no provider: every provider's logins.

The selection is consulted because the task sends **no** `agentProfile`:
`resolvePoolForDispatch` (`packages/cezar/src/workspace/agent-route-select.ts:258-266`) parses
`options.agentProfile ?? selectionFor(accounts, repoRoot, fallbackProvider)`, and
`fallbackProvider` is `input.runner ?? config.defaultRunner` (`run.ts:5389-5392`): `claude`, since
the POST body sets `"runner": "claude"`. So this fixture reproduces the reported bug in its
original shape: a pool chosen in Settings, a task that names nothing, and a logged-out claude.

`selections` is keyed by the project's **realpath'd** root, so `REPO_REAL=$(readlink -f "$REPO")`.

**`configDir` is load-bearing here, not decorative.** `profileEnv('codex', configDir)`
(`packages/cezar/src/core/agent-profiles.ts:66-71`) sets `CODEX_HOME=<configDir>` for the fixture
account's probe and for its spawned run, and sets **nothing** for the discovered default. The codex
shim branches on `$CODEX_HOME` (P2 step 3) precisely so the two codex profiles answer differently:
without that branch a single shim reports *both* codex profiles connected, `selectPoolAccount`
picks between them on in-flight and last-dispatch, and `selectedAccount` becomes nondeterministic,
a flake that would look like a routing bug. The directory itself is an empty scratch dir; its
contents are never read, but it must exist and be named, because the store schema requires it.

**`$CEZ_HOME/agent-account-usage.json`** (`agent-account-usage.ts:143`, `recordLimited` at
`:257-268`, path from `paths.ts:141-143`), the waitable fixture for step 7. Keyed by
`accountUsageKey(provider, accountId)`:

```json
{ "accounts": { "codex:codex-fixture": { "limited":
    { "since": "2026-08-29T00:00:00Z", "source": "e2e", "until": "<+2h ISO>" } } } }
```

**The `run.account_fallback` event.** It is a `type: 'metric'` event, not a note
(`packages/cezar/src/workflows/run.ts:3261-3276`, `:3364`, `:3614-3637`). Fields asserted in P2:

```
type, name, runId, stepId?, workflow, site, requestedRoute, requestedProvider,
requestedAccount?, selectedProvider, selectedAccount, selectedTier, cause, skippedDisconnected
```

Read from `notePoolSkip` on `origin/main` (`run.ts:3615-3638`), the **pool** site emits exactly:

```json
{ "type": "metric", "name": "run.account_fallback", "runId": "<id>", "workflow": "quick-task",
  "site": "pool", "requestedRoute": "pool:*",
  "selectedProvider": "codex", "selectedAccount": "codex:codex-fixture",
  "selectedTier": "runnable", "cause": "credentials",
  "skippedDisconnected": ["claude:default"] }
```

Four properties matter for writing the assertions correctly and are easy to get wrong:

- **`requestedRoute` is the literal string `pool:*`.** It is `formatAgentRoute({kind: 'pool'})`
  (`run.ts:3624`), and `formatAgentRoute` (`agent-route.ts:83-86`) returns `AGENT_POOL_ALL` for a
  provider-less pool. This is the field that distinguishes the criterion's scenario from the
  explicit-account one, so assert it by value, not by presence.
- **`requestedProvider` is set to `undefined`** at this site (`run.ts:3626`), so it is **absent**
  from the serialized JSON. `jq -e '.requestedProvider == null'` holds; an assertion that expects a
  string there fails on a correct event.
- The metric is emitted by `notePoolSkip` **only when something was actually excluded**
  (`run.ts:3616`, `if (!choice?.skippedDisconnected?.length) return`). The fixture must therefore
  contain a disconnected claude candidate in the pool, which it does. A fixture with nothing to
  skip produces no event and the assertion would fail for the wrong reason.
- `selectedAccount` and every member of `skippedDisconnected` are `accountUsageKey` values:
  `` `${provider}:${accountId || 'default'}` `` (`packages/contract/src/usage-hold.ts:49-51`), with
  `isDefault` accounts passed `undefined` and therefore spelled `<provider>:default`
  (`agent-route-select.ts:283-285`). So the logged-out claude appears as **`claude:default`**, not
  as `claude`.
- At the pool site `selectedTier` is an approximation the code documents as such
  (`run.ts:3628-3634`): `waitable` if the account is in a recorded hold, else `runnable`. Assert
  `selectedTier` strictly only in step 7, where the hold is the thing being staged.

**Where the events actually are.** A run's events are appended by `store.appendEvent` to
`<repoRoot>/.ai/cezar/runs/<runId>.ndjson`: one JSON object per line, finite, complete, and not
paginated. That file is the assertion source for every event claim in P2. Neither HTTP route is:
`GET /runs/:id/events` is an **indefinite SSE stream** (`server.ts:6484-6510`,
`streamSSENoBuffer`), so `curl … | jq` on it never terminates, and `GET /runs/:id/history`
(`server.ts:5367-5384`) answers a **paginated, canonicalized page** (`readRunHistoryPage` →
`canonicalSessionItems`, `runs/event-history.ts:403-440`) that selects display items rather than
raw appended events. Fetch `/runs/:id/history` once as a smoke check that the route answers `200`,
and assert on the `.ndjson`.

**Routes used by P2**, all on the isolated server at `http://127.0.0.1:47311/api/v1`:

| Route | Used for |
| --- | --- |
| `GET /ready` | readiness poll; `503` until every check passes. Do **not** assert its `deploy` field: a locally launched secondary has no release stamp. |
| `GET /health` | informational, read once, kept as an artifact. |
| `GET /providers/status?refresh=1` | one row **per provider**, and that row is the discovered **default** (`packages/contract/src/workspace.ts:450-454`). Under `env -i` both defaults are credential-less, so both read not-connected; `poolConnected` on codex is the aggregate that carries the fixture. |
| `GET /workspace/agent-profiles/codex-fixture/status?refresh=1` | the per-account answer, direct evidence the fixture is connected. Answers an **envelope**, `{"status": {…}}` (`server.ts:3319-3326`), so the assertion is `.status.status == "connected"`, never `.status == "connected"`. Needs `CEZ_ACCOUNT_USAGE=1`, else `409 account balancing is off on this server` (`server.ts:3435`). |
| `POST /projects`, body `{"root": "<REPO_REAL>"}` | register the scratch repo. Answers **`200`**, not `201`, with `{"project": {…}}` (`server.ts:3848-3854`). On the **boot** root it is an idempotent short circuit that writes no registry row (`server.ts:4277-4294`). |
| `GET /projects` | read `.bootProject`, which is the `:project` segment below. Do **not** read `.projects[] \| select(.root == …) \| .id`: the scratch repo is the boot project and therefore has no registry row to select. |
| `POST /p/:project/runs` | the dispatch under test. |
| `GET /p/:project/runs/:id` | the run record the assertions read. |
| `GET /p/:project/runs/:id/history` | smoke check only, see the paging caveat above. |

**CORRECTED 2026-08-29 (review, extended in the second review): five of these were wrong in
earlier drafts**, and each would have failed the phase for a reason unrelated to the feature. Read
from `origin/main`:

- **There is no `POST /workspace/projects`.** Registration is `POST /api/v1/projects`
  (`server.ts:3848`), relative path `/projects`, and the body field is **`root`**, not `path`:
  `registerProjectSchema = z.object({ root: z.string().trim().min(1).max(4096), teamId: …optional })`
  (`server.ts:4163-4166`). A wrong field name answers `400 root must be a non-empty path`.
- **`POST /p/:project/runs` answers a raw `RunRecord`, not `{run}`**: `return c.json(run, 201)`
  (`server.ts:5356`). Read `.id`. The `{run}` envelope belongs to a different route (the
  todo-start path, `server.ts:6477`), and `{runs: [...]}` to the `variants > 1` path
  (`server.ts:5348`), which this phase never takes because it posts one variant.
- **`GET /p/:project/runs/:id` also answers a raw record** (`server.ts:5361-5365`,
  `c.json(withUsage(run))`). Assert `.runner`, `.agentProfile`, `.steps` at the top level, never
  under `.run`.
- **CORRECTED 2026-08-29 (second review): the per-account status route answers an ENVELOPE.**
  `GET /workspace/agent-profiles/:id/status` returns `c.json({ status: … })` on both of its
  branches, the `isDefault` one and the probing one (`server.ts:3312-3326`), so the connected
  answer is at `.status.status`. The assertion `jq -e '.status == "connected"'` compares an
  **object** to a string and is false on a correctly staged fixture, which would have stopped P2 at
  step 5 with the fixture actually working.
- **CORRECTED 2026-08-29 (second review): the boot project has no row in `GET /projects`.**
  `registerFolder` short circuits when the requested root **is** the boot root, resolving to the
  boot identity with no registry write, no team claim and no `project-added` event
  (`server.ts:4277-4294`, guarding `2026-08-15-duplicate-project-context-wipes-runs.md`). Since P2
  launches the secondary with the scratch repo as its boot project, `GET /projects` answers
  `{projects, bootProject, projectsDir}` (`server.ts:3707-3730`) whose `.projects[]` does **not**
  contain that root, and `jq -re '.projects[] | select(.root == $root) | .id'` exits non-zero on a
  perfectly healthy server.

The `:project` segment is therefore `GET /projects` → **`.bootProject`**, cross-checked against
`POST /projects` → `.project.id`, and never derived from the folder name or selected out of
`.projects[]`. The same routes are also mounted unscoped under `/api/v1/…` bound to the **boot**
project (`server.ts:2299`), which is the scratch repo here, so either spelling works; P2 uses the
explicit `/p/:project/…` form so the assertions name what they targeted.

---

## Phases

Each phase is stop-safe on its own: stopping after any of them leaves the repository unchanged or
consistently changed, and leaves production untouched throughout. P0 and P1 change no file. P2
changes no file in the repository. P3 is the only phase that writes.

### P0. Pin the revision and re-measure (stop-safe: read-only)

Nothing in this spec may be trusted as a constant, because main moved twice while it was being
written (M3). First action of the implementation step:

```sh
cd /var/lib/cezar/loki-labs/cezar && git fetch --quiet origin
PIN=$(git rev-parse origin/main); echo "PIN=$PIN"
READY=$(curl -fsS --max-time 15 http://127.0.0.1:4321/api/v1/ready)
LIVE=$(printf '%s' "$READY" | grep -o '"sha":"[0-9a-f]*"' | grep -o '[0-9a-f]\{7,40\}' | head -1)
LIVE_RELEASE=$(printf '%s' "$READY" | grep -o '"releaseId":"[^"]*"' | cut -d'"' -f4)
LIVE_PID=$(systemctl show cezar.service -p MainPID --value)
echo "LIVE=$LIVE LIVE_RELEASE=$LIVE_RELEASE LIVE_PID=$LIVE_PID"
git merge-base --is-ancestor d385cd5c "$PIN"  && echo "feature is on the pinned tree"
git merge-base --is-ancestor d385cd5c "$LIVE" && echo "feature is in production"
```

Both `--is-ancestor` checks must exit `0`. If the second one ever fails, the TLDR's central claim
has expired, this spec's scope is wrong, and the right move is to stop and say so rather than to
proceed on its plan. Record `PIN`, `LIVE`, `LIVE_RELEASE` and `LIVE_PID` in the run report; every
later phase names `PIN`, and P3 and W6/W7 name `$LIVE_RELEASE` and `$LIVE_PID` rather than any
literal copied out of this document. Both moved once between this spec being written and being
reviewed; treating either as a constant is how a report ends up quoting a release that is no longer
running.

**Then synchronize this run's own worktree, before P3 edits anything in it.** Measured 2026-08-29:
the task worktree
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/55e9d5df-a9da-4d04-a1d1-ef107cea4842` is at
`2fd01a16` on branch `cez/55e9d5df`, **22 commits behind `origin/main`**, and does **not** contain
`.ai/specs/2026-08-25-logged-out-account-fallback.md`, the very file P3(a) and P3(b) must edit.
Editing it there is impossible, and committing P3 from an unsynchronized branch would revert 22
commits of `main`.

```sh
W=/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/55e9d5df-a9da-4d04-a1d1-ef107cea4842
cd "$W"
git stash push -u -m "spec+brief for 55e9d5df" -- \
  .ai/specs/2026-08-29-verify-logged-out-fallback.md \
  .ai/specs/briefs/2026-08-29-logged-out-fallback-landing.md
git merge --ff-only "$PIN" || git rebase "$PIN"
git stash pop
test -f .ai/specs/2026-08-25-logged-out-account-fallback.md && echo "feature spec is now present"
git rev-list --count HEAD..PIN 2>/dev/null || git rev-list --count "HEAD..$PIN"   # want 0
```

The two new files are preserved across the move and **no intermediate commit is made**: this run
still ships one commit, containing this spec, the brief and P3's corrections, on top of `PIN`. The
gates in P1 run in a clean checkout of `PIN` (below), which is not this worktree; the final commit
is what must sit on `PIN`.

Also re-read `cezar todo list` for `21e18103` and `541c8214`, so P3 closes the right row.

### P1. Five gates, twice, on `PIN` (stop-safe: green or stop, nothing committed)

Run in a clean checkout of `PIN`, from the repo root, in this order, each to completion:

```sh
env -u CEZ_DRY_RUN -u CEZ_AGENT_MODELS_LOCKED npm ci --include=dev
env -u CEZ_DRY_RUN -u CEZ_AGENT_MODELS_LOCKED npm run typecheck
env -u CEZ_DRY_RUN -u CEZ_AGENT_MODELS_LOCKED npm test
env -u CEZ_DRY_RUN -u CEZ_AGENT_MODELS_LOCKED npm run test:unit
env -u CEZ_DRY_RUN -u CEZ_AGENT_MODELS_LOCKED npm run build
env -u CEZ_DRY_RUN -u CEZ_AGENT_MODELS_LOCKED npm run test:package     # <- this is V7
```

Rules, taken from the feature spec's V5 (`:1995-2018`) and not softened:

- **The exit code is the verdict.** A non-zero exit is a stop, not a note. There is no
  accepted-failures list, and recognising a failing test's name is not a pass.
- **Twice.** A suite that passes once and fails once has not passed.
- An isolated rerun (`npm test -- run <file>`, never `npx vitest`) is a legitimate **diagnostic**
  that establishes where a failure lives. It never converts a red full run into a pass.
- If anything is red, quote the command, the failing file, the test name and the assertion output,
  and stop. If it is claimed pre-existing, prove it by running the same command on an unmodified
  checkout of the merge base and quoting **both** results.

**Scrub the environment** rather than trusting it. `CEZ_DRY_RUN=1` makes `ProviderAuthService`
answer connected for every provider and every account
(`provider-auth.ts:583-585`, `:592-594`, `:528-530`, `reportRuntimeAuthFailure` a no-op at `:420`),
and `CEZ_AGENT_MODELS_LOCKED=1` reaches the same short-circuit through `providerAuthChecksDisabled`
(`:57-62`). Either one turns V7's four cases into assertions about nothing, all of them green. This
is the single way P1 can report a pass it did not earn, so the scrub is not optional and the
absence of both variables should be echoed into the log before the run.

**Expected result, stated as a prediction so a surprise is visible:** all five green, and
`config-api.test.ts` green, because `fe4287c2` fixed it on main. If `config-api.test.ts` is red,
that is new information and it is a stop, not the known-failure this task's context describes.

Deliverable: the two runs' output, quoted, with `PIN`, and an explicit statement that V7's four
cases ran and passed.

### P2. V6, on an isolated secondary server (stop-safe: repository untouched, `$ART` retained)

Follow `.ai/specs/2026-08-25-logged-out-account-fallback.md:2028-2422`, with step 4's credential
copy replaced per the declared deviation. **The numbering below is this spec's own and does not
track the feature spec's**, because the review of 2026-08-29 moved the browser case ahead of
teardown: the feature spec's step 10 is this spec's step 7, and teardown is step 10 here. Where a
step corresponds to one there, it says so. Concretely:

1. **Two scratch trees, the fixture tree, and the guarded trap.** The trees and the trap are
   `:2043-2075` verbatim: `$ART` retained, `$CREDS` removed, trap armed before the first fixture is
   written, `kill` pid-guarded so it can never become `kill 0`. Two additions, both **CORRECTED
   2026-08-29 (second review)**, go in this step and nowhere later.

   **(a) The fixture tree, restored.** The declared deviation replaced the feature spec's step 4,
   and that step carried the tree creation everything downstream depends on (`:2192-2196`): `$REPO`,
   its `git init`, `$REPO_REAL`, and the scratch `CEZ_HOME`. Dropping step 4 dropped them too, so
   the earlier draft's steps 3 and 5 named `$REPO`, `$CREDS/bin` and `$CREDS/codex-config` before
   anything created them. Create them here, before the first shim is written and before the server
   is launched:

   ```sh
   REPO="$CREDS/project"
   mkdir -p "$REPO" "$CREDS/bin" "$CREDS/codex-config" "$CREDS/home/.cezar"
   git -C "$REPO" init -q
   REPO_REAL=$(readlink -f "$REPO")
   echo "REPO_REAL=$REPO_REAL" | tee "$ART/repo-real"
   ```

   Each of the four exists for a named reason. `$REPO` is the project under test and is `git
   init`'d because cezar treats a project root as a repo throughout; `$CREDS/bin` is the shim
   directory step 3 puts at the front of `PATH`; `$CREDS/codex-config` is the fixture account's
   `configDir`, which must exist and be named even though nothing reads its contents (Data models);
   `$CREDS/home/.cezar` is the scratch `CEZ_HOME` that `agent-accounts.json` and
   `agent-account-usage.json` are written into. `$REPO_REAL` is the realpath, because that is the
   key `selections` is stored under and `/var/tmp` is a symlink on some hosts.

   **(b) The trap closes the browser session too.** The inherited `cleanup()` kills `$SRV` and
   removes `$CREDS`, and does nothing else, so the earlier draft's claim that browser cleanup "runs
   in the trap" was false: a browser command that failed anywhere in step 7 would leave a live
   `agent-browser` session on the box, which is the escaped-fixture failure R4 exists to prevent.
   Declare the browser variables **before** the trap and close conditionally inside `cleanup()`:

   ```sh
   AB=/var/lib/cezar/.cache/agent-tools/agent-browser/agent-browser-linux-x64
   SESSION="v6-$$"
   BROWSER_OPEN=0          # set to 1 by step 7's first successful `open`, back to 0 by its `close`

   cleanup() {
     if [ "${BROWSER_OPEN:-0}" = "1" ] && [ -x "$AB" ]; then
       "$AB" --session "$SESSION" close --json >>"$ART/browser-close.json" 2>&1 || true
       BROWSER_OPEN=0
     fi
     # …then the inherited body, unchanged: the pid-guarded kill of $SRV, `rm -rf "$CREDS"`,
     # and `echo "artifacts retained in $ART"`.
   }
   trap cleanup EXIT INT TERM
   ```

   The inline `close` in step 7 stays as well and clears `BROWSER_OPEN`, so the ordinary path closes
   the session where it is used and the trap is only the backstop.
2. **The live baseline, captured after `$ART` exists.** Two things, not one:

   ```sh
   # (a) the non-interference gate: release, pid, and the live stores' hashes/mtimes
   curl -fsS http://127.0.0.1:4321/api/v1/ready | jq -S . > "$ART/live-ready-before.json"
   systemctl show cezar.service -p MainPID --value          > "$ART/live-pid-before"
   sha256sum /var/lib/cezar/.cezar/agent-accounts.json      > "$ART/live-stores-before.sha256"
   stat -c '%n %Y' /var/lib/cezar/.cezar/agent-accounts.json /var/lib/cezar/.cezar/config.json \
        /var/lib/cezar/.claude /var/lib/cezar/.claude-secondary \
        /var/lib/cezar/.codex  /var/lib/cezar/.codex-secondary 2>/dev/null \
                                                            > "$ART/live-stores-before.mtimes"
   # (b) the diagnostic: no `?refresh=1`, so the live service spawns no probe of its own
   curl -fsS http://127.0.0.1:4321/api/v1/providers/status | jq -S . > "$ART/live-before.json"
   ```

   A live service that does not answer is a stop before anything is launched. (a) is what step 10
   asserts on; (b) is what step 10 reports.

   **All FOUR live credential homes, not two. CORRECTED 2026-08-29 (second review).** Measured on
   the box today, `ls -d` returns all four of `/var/lib/cezar/.claude`,
   `/var/lib/cezar/.claude-secondary`, `/var/lib/cezar/.codex` and
   `/var/lib/cezar/.codex-secondary`: this box runs a secondary login for **both** providers, which
   is the whole reason the feature spec's `LIVE_CODEX_HOME` scalar guard fails open here (P-D). The
   earlier draft stat'd only the two codex homes, so a secondary process that wrote a **claude**
   credential home would have passed the non-interference gate with nothing to show for it.

   **And state the limit of the check rather than overclaiming it.** A directory mtime moves when
   an entry is created, renamed or removed, and does **not** move when an existing file inside it is
   rewritten in place, so these four lines bound the blast radius and do not prove byte-level
   immutability of the credentials. The strong check in this set is the `sha256sum` on
   `agent-accounts.json`. The homes are deliberately left at mtime granularity: hashing the contents
   of a live credential store is a read this phase should not be doing at all, and W6 says so in
   those terms rather than claiming more than it measured.
3. **Launch the artifact under test by absolute path**, `node "$BUILD" serve --repo "$REPO"
   --port 47311 --port-strict`, where `$BUILD` is P1's built `packages/cezar/dist/index.js` from the
   `PIN` checkout. `sha256sum` it into `$ART/artifact.sha256` and the pid into `$ART/server.pid`, so
   "we tested the new code" is checkable rather than asserted. `--port-strict` turns a busy port
   into a stop instead of a silent drift onto a port no assertion is aimed at.
   **`--repo "$REPO"` is not optional** (`index.ts:147`, "repo to operate on (default: cwd)"): it
   makes the scratch repo the **boot** project, which is what puts every run's event file at
   `$REPO_REAL/.ai/cezar/runs/<id>.ndjson` where steps 6 and 8 read it, and what stops the secondary
   from resolving against whatever directory the operator happened to be standing in. Launching with
   `$REPO` as cwd is equivalent; naming it explicitly is what makes the run reproducible from the
   report. It is also why `:project` comes from `.bootProject` rather than a registry lookup, see
   Data models.
   The `env -i` block carries `PATH`, `HOME`, `CEZ_HOME`, `CEZ_E2E_LOG="$ART"` and
   `CEZ_ACCOUNT_USAGE=1`, the last because the per-account status route this phase asserts on
   answers `409 account balancing is off on this server (CEZ_ACCOUNT_USAGE=1)` without it
   (`server.ts:3435`, and the same capability gates a body-supplied `agentProfile` at
   `server.ts:2812-2813`), plus the deviation's two variables:

   ```sh
   CEZ_CLAUDE_BIN="$CREDS/bin/claude-shim.sh" \
   CEZ_CODEX_BIN="$CREDS/bin/codex-shim.sh"
   ```

   The two shims are written first and `chmod +x`. They mirror `package-cli.test.ts:288-344` with
   **two deliberate additions**, both forced by code that the packed CLI test never reaches:

   **(a) An explicit `--version` branch on each.** `GET /health` calls `detectEnvironment()`
   (`server.ts:2403`), whose `probeClaude`/`probeCodex` run **the overridden binary** with
   `--version` (`core/backend-detect.ts:37-44`, `:68-70`). The packed test's codex shim falls
   through to its catch-all, which would append that call to `codex.other` and exit `1`, directly
   contradicting R5's `codex.other` must stay empty, and reporting codex as unavailable in
   `/health`. So `--version` is answered, exits `0`, and is logged as a **probe**, never as
   "other". Claude's banner must additionally satisfy
   `/^\d+\.\d+|^claude(\s+code)?\s+version\s+\d+\.\d+/i` (`backend-detect.ts:44`) or claude is
   dropped from the composer's runner list, which would make the fixture "claude is not
   installed", not "claude is logged out", a different bug entirely.

   **(b) The codex shim branches on `$CODEX_HOME`.** `profileEnv('codex', configDir)`
   (`core/agent-profiles.ts:66-71`) sets it for the fixture account and leaves it unset for the
   discovered default, and `defaultRunProviderCommand` passes it through as
   `{...process.env, ...env}` (`core/provider-auth.ts:283-289`). One shim serving both profiles
   without this branch reports both codex logins connected and makes `selectedAccount`
   nondeterministic; see Data models.

   ```sh
   cat >"$CREDS/bin/claude-shim.sh" <<'SH'
   #!/bin/sh
   # Installed, and logged OUT. `auth status --json` is what provider-auth asks
   # (core/provider-auth.ts:233-236).
   if [ "${1:-}" = "--version" ]; then
     echo "--version" >> "$CEZ_E2E_LOG/claude.probe"
     printf '2.0.0 (Claude Code)\n'; exit 0
   fi
   if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then
     echo "$*" >> "$CEZ_E2E_LOG/claude.probe"
     printf '{"loggedIn":false}\n'; exit 1
   fi
   echo "$*" >> "$CEZ_E2E_LOG/claude.run"      # THE assertion file: this must never appear
   exit 1
   SH

   cat >"$CREDS/bin/codex-shim.sh" <<SH
   #!/bin/sh
   set -eu
   MOCK=$(printf '%q' "$MOCK")
   FIXTURE_HOME=$(printf '%q' "$CREDS/codex-config")
   if [ "\${1:-}" = "--version" ]; then
     echo "--version" >> "\$CEZ_E2E_LOG/codex.probe"
     printf 'codex-cli 0.60.0\n'; exit 0
   fi
   if [ "\${1:-}" = "login" ] && [ "\${2:-}" = "status" ]; then
     echo "\$* CODEX_HOME=\${CODEX_HOME:-<unset>}" >> "\$CEZ_E2E_LOG/codex.probe"
     if [ "\${CODEX_HOME:-}" = "\$FIXTURE_HOME" ]; then
       printf 'Logged in using ChatGPT\n'; exit 0
     fi
     printf 'Not logged in\n'; exit 1
   fi
   if [ "\${1:-}" = "app-server" ]; then
     echo "\$* CODEX_HOME=\${CODEX_HOME:-<unset>}" >> "\$CEZ_E2E_LOG/codex.run"
     exec node "\$MOCK" "\$@"
   fi
   echo "\$*" >> "\$CEZ_E2E_LOG/codex.other"
   exit 1
   SH
   chmod +x "$CREDS/bin/claude-shim.sh" "$CREDS/bin/codex-shim.sh"
   ```

   `$MOCK` is `<PIN checkout>/packages/cezar/scripts/mock-codex-app-server.mjs` (packed: it is in
   `packages/cezar/package.json`'s `files`), resolved to an absolute path and `test -f`'d before
   the server launches; the run path reaches it through `resolveCodexExecutable`
   (`core/codex-app-server-transport.ts:33-35`), which reads the same `CEZ_CODEX_BIN`.
   Use `exec`, not a nested spawn: the transport speaks JSON-RPC over the process's own stdio and
   an extra pipe hop measurably deadlocked in the packed test.
4. **Readiness then health**, on the two distinct routes, polled to a 120s deadline with `kill -0`
   on the pid so a dead server fails fast instead of being waited on forever.
5. **Register the project, then the fixture account and the `pool:*` selection**, per the Data
   models section, in that order: the store's `selections` key is the project's realpath'd root, so
   the repo must be registered and `$REPO_REAL` (step 1) known first.

   ```sh
   curl -fsS -X POST "$API/projects" -H 'content-type: application/json' \
        -d "$(jq -nc --arg root "$REPO_REAL" '{root:$root}')" > "$ART/project.json"   # 200, not 201
   PROJ=$(curl -fsS "$API/projects" | tee "$ART/projects.json" | jq -re '.bootProject')
   jq -e --arg id "$PROJ" '.project.id == $id' "$ART/project.json"   # the two agree, or stop
   # then write agent-accounts.json (Data models) and re-probe
   curl -fsS "$API/providers/status?refresh=1" > "$ART/providers.json"
   curl -fsS "$API/workspace/agent-profiles/codex-fixture/status?refresh=1" > "$ART/codex-fixture.json"
   ```

   Then assert the split with five `jq -e` calls that must all exit `0`:

   ```sh
   jq -e '[.providers[] | select(.provider=="claude")][0].status != "connected"' "$ART/providers.json"
   jq -e '[.providers[] | select(.provider=="codex")][0].status  != "connected"' "$ART/providers.json"
   jq -e '[.providers[] | select(.provider=="codex")][0].poolConnected == true'  "$ART/providers.json"
   jq -e '.status.status == "connected"' "$ART/codex-fixture.json"   # ENVELOPE: `.status.status`
   grep -q 'CODEX_HOME=<unset>' "$ART/codex.probe"        # the default codex WAS probed, and answered not-connected
   ```

   `/providers/status` answers exactly one row per provider, the discovered **default**
   (`packages/contract/src/workspace.ts:450-454`), so the first two are the two logged-out defaults,
   and `poolConnected` is the aggregate that carries the fixture (`:456-461`). The fourth is
   `.status.status`, not `.status`, because that route wraps its answer
   (`server.ts:3312-3326`); the earlier draft's `.status == "connected"` compares an object to a
   string and is false even when the fixture is perfectly staged. If the fourth or fifth fails the
   fixture is not staged and the E2E **stops here**, because every later assertion would then pass
   for the wrong reason.
6. **The healthy-fallback case:** `POST /p/$PROJ/runs` with
   `{"task": "...", "workflow": "quick-task", "runner": "claude"}` and **no `agentProfile`**, which
   is the reported bug in one request: the route comes from the project's stored `pool:*` selection,
   exactly as it does when a user picks a pool in Settings.

   ```sh
   RUN=$(curl -fsS -X POST "$API/p/$PROJ/runs" -H 'content-type: application/json' \
         -d '{"task":"take the healthy fallback","workflow":"quick-task","runner":"claude"}' \
         | tee "$ART/start.json" | jq -re '.id')          # RAW RunRecord: `.id`, not `.run.id`

   # POLL. CORRECTED 2026-08-29 (second review): the earlier draft had a comment here where the
   # loop belongs, then read the record once. `POST` answers 201 as soon as the record EXISTS,
   # which is before `resolvePoolForDispatch` has run and before `runner`/`agentProfile` have been
   # rewritten to the chosen account (`run.ts:5389-5411`, `:5464`), so an immediate GET races the
   # dispatch and reads `runner: "claude"` on a run that is about to do exactly the right thing.
   deadline=$(( $(date +%s) + 180 ))
   while :; do
     if ! kill -0 "$(cat "$ART/server.pid")" 2>/dev/null; then
       echo "the server under test died"; tail -80 "$ART/server.log"; exit 1
     fi
     curl -fsS "$API/p/$PROJ/runs/$RUN" > "$ART/run.json" || true   # RAW RunRecord, top-level fields
     # PASS is checked first, so a run that satisfies it and then ends does not fail on the
     # terminal check below.
     if jq -e '.runner == "codex" and .agentProfile == "codex-fixture"
               and ([.steps[]?.profileId] | any(. == "codex-fixture"))' \
             "$ART/run.json" >/dev/null 2>&1 && [ -s "$ART/codex.run" ]; then
       break
     fi
     if [ -e "$ART/claude.run" ]; then
       echo "FAIL: claude was RUN on a logged-out login"; cat "$ART/claude.run"; exit 1
     fi
     if jq -e '.status == "failed" or .status == "cancelled" or .status == "done"' \
             "$ART/run.json" >/dev/null 2>&1; then
       echo "FAIL: the run reached a terminal status without recording the codex fallback"
       jq -S . "$ART/run.json"; exit 1
     fi
     if [ "$(date +%s)" -ge "$deadline" ]; then
       echo "FAIL: 180s and the run never recorded the codex fallback"
       jq -S . "$ART/run.json"; tail -80 "$ART/server.log"; exit 1
     fi
     sleep 2
   done

   curl -fsS -o "$ART/history.json" -w '%{http_code}\n' "$API/p/$PROJ/runs/$RUN/history" # smoke: 200
   cp "$REPO_REAL/.ai/cezar/runs/$RUN.ndjson" "$ART/events.ndjson"
   ```

   The four pass conditions are one claim each and the conjunction is the point: `runner` and
   `agentProfile` say the **record** was rewritten to the fallback account (`run.ts:5464`),
   `.steps[].profileId` says the step that would actually spawn carries it too, and a non-empty
   `$ART/codex.run` says the codex shim was really invoked rather than only probed. `done` counts as
   a failure in the loop body because the only way this fixture completes without those fields is by
   having run somewhere else. The statuses are `runStatusSchema`
   (`packages/contract/src/runs.ts:30-38`): `queued`, `running`, `waiting`, `review`, `done`,
   `failed`, `cancelled`. **`waiting` and `review` are deliberately not terminal here**, since a
   long agent turn passes through them.

   Assert on the **record** and on the **event file**, never on `/runs/:id/events` (an indefinite
   SSE stream) and never on `.run.*` (there is no envelope):

   ```sh
   jq -e '.runner       == "codex"'        "$ART/run.json"
   jq -e '.agentProfile == "codex-fixture"' "$ART/run.json"   # `chosen.accountId`, run.ts:5464
   jq -e '[.steps[].profileId] | any(. == "codex-fixture")' "$ART/run.json"
   jq -se '[.[] | select(.name == "run.account_fallback")] as $m
           | ($m | length) >= 1
           and ($m[0].type              == "metric")
           and ($m[0].site              == "pool")
           and ($m[0].requestedRoute    == "pool:*")
           and ($m[0].selectedProvider  == "codex")
           and ($m[0].selectedAccount   == "codex:codex-fixture")
           and ($m[0].cause             == "credentials")
           and ($m[0].skippedDisconnected | index("claude:default") != null)' "$ART/events.ndjson"
   test ! -e "$ART/claude.run"
   ```

   The last line is the behaviour; the rest is the record. An event without the behaviour is a lie,
   and the behaviour without the event is unmeasurable. `$ART/claude.probe` **existing** is expected
   and correct: probing a logged-out account is fine, running on it is the bug.
7. **The browser case, while the server and this run are still alive.** It runs **here**, before
   any teardown: the previous draft stopped the server and deleted `$CREDS` in step 9 and then
   navigated to port 47311 in step 10, which cannot work.

   **Not `npm run test:e2e`**, which boots its own environment, cannot be pointed at a running
   port, and is allowed to exit `0` with `TEST_E2E_STATUS=skipped`, a pass-shaped non-result. And
   **not Playwright**, which is not a dependency of this repository (M6). Drive the repo's own
   browser seam, the `agent-browser` binary that `.ai/agentic.config.json` names and that every
   `packages/web/e2e/*.e2e.ts` spec uses through `packages/web/e2e/agent-browser.ts`:

   ```sh
   # $AB and $SESSION are declared in step 1(b), BEFORE the trap, so `cleanup()` can close this
   # session on any failure path. Do not re-declare them here.
   J() { "$AB" --session "$SESSION" "$@" --json; }          # --json on every call: parsed, never scraped

   J open "http://127.0.0.1:47311/p/$PROJ/tasks/$RUN"       > "$ART/browser-open.json"
   BROWSER_OPEN=1                                           # the trap now owns this session
   J wait '[data-slot="composer"] textarea'                 > "$ART/browser-wait.json"
   J eval 'JSON.stringify({disabled: document.querySelector(`[data-slot="composer"] textarea`).disabled})' \
                                                            > "$ART/composer-state.json"
   J snapshot                                               > "$ART/browser-snapshot.json"
   J fill '[data-slot="composer"] textarea' 'v6 composer is live'  > "$ART/browser-fill.json"
   J screenshot "$ART/composer.png"                         > "$ART/browser-screenshot.json"
   J press Enter                                            > "$ART/browser-send.json"
   J wait '2000'
   J get text 'main'                                        > "$ART/thread-text.json"
   J screenshot "$ART/thread-after-send.png"                > "$ART/browser-screenshot2.json"
   "$AB" --session "$SESSION" close --json                  > "$ART/browser-close.json"
   BROWSER_OPEN=0                                           # closed on the ordinary path
   ```

   The route is `/p/:projectId/tasks/:id` (`packages/web/src/routes.tsx:502-511`). The selectors
   are the ones this repo's own e2e specs use: `[data-slot="composer"] textarea` and
   `[aria-label="Send"]` (`packages/web/e2e/composer.e2e.ts:111-167`); there are **no
   `data-testid`s in this codebase** (`routes/task-thread/retarget-hint.test.tsx:150`), so do not
   invent one.

   Assert: `composer-state.json` reports `disabled: false`, `thread-text.json` contains
   `v6 composer is live`, and both PNGs exist and are non-empty. `close` runs inline **and** from
   `cleanup()`, because step 1(b) puts it there: the trap this step inherited from the feature spec
   kills the server and removes `$CREDS` and nothing more, so without that addition a failed
   `wait`, `fill` or `eval` would leave a live browser session on the box. **There is no video**,
   `agent-browser screenshot --help` offers no recording mode and the tool has no `record` command
   (M6), so the artifacts are the two screenshots plus the accessibility snapshot. If the binary
   cannot launch as `cezar`, that is a **skip, reported as a skip** (R7), and V6 is not complete.
8. **The waitable case, on the EXPLICIT default route. CORRECTED 2026-08-29 (second review): the
   retained `pool:*` selection cannot produce a waitable placement at all.** The earlier draft said
   `run.ts:3634` reads `accountHolds().deadline`, "which is what the `limited` entry populates".
   It does not, and three facts on `origin/main` say so. Together they mean the earlier version of
   this step would have **spawned the codex shim** and then failed its own `selectedTier`
   assertion, on entirely correct code:

   - `resolvePoolForDispatch` classifies pool candidates with `credentialTier`, which is
     **two-valued and never returns `waitable`** by construction (`run.ts:5401` passes it,
     and its own doc comment says "Never `'waitable'`: this is a two-valued question in disguise").
     A `limited` entry therefore does not remove `codex:codex-fixture` from the candidate set
     (`agent-route-select.ts:268-272` filters on `=== 'disconnected'` only): it is chosen, the
     cursor advances, and the run starts.
   - `notePoolSkip` runs **immediately** after that resolution (`run.ts:5403`), before any hold can
     exist, and derives `selectedTier` from `this.semaphore.accountHolds().deadline`
     (`run.ts:3628-3635`), not from `agent-account-usage.json`. Its own comment calls this "an
     approximation". `accountHolds()`'s deadline set is built from **failed run records carrying a
     live `autoResumeAt`** (`.ai/specs/2026-08-23-usage-limit-hold-account.md`;
     `workflows/account-fallback.test.ts:269` states the fixture shape), which a hand-written
     `limited` entry does not create. The pool site would emit `selectedTier: "runnable"`.
   - The `waitable` **placement** that actually parks a run comes from
     `rerouteExplicitAccountIfUnavailable`, and that is reached only when `pooled` is `undefined`
     (`run.ts:5407-5411`), which means only when the project's stored selection parses as an
     **account** rather than a pool (`agent-route-select.ts:266`, `route.kind !== 'pool'`).

   So this step flips the claude selection to the explicit default first, and asserts the
   `explicit-reroute` shape:

   ```sh
   # 1. how many times codex has been dispatched to so far, so this step can prove it did NOT spawn
   CODEX_RUNS_BEFORE=$(wc -l < "$ART/codex.run")

   # 2. quota-limit the fixture, and make claude's route explicit rather than a pool
   jq -n --arg until "$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)" \
     '{accounts:{"codex:codex-fixture":{limited:{since:"2026-08-29T00:00:00Z",source:"e2e",until:$until}}}}' \
     > "$CREDS/home/.cezar/agent-account-usage.json"
   jq --arg root "$REPO_REAL" '.selections[$root].claude = "default"' \
      "$CREDS/home/.cezar/agent-accounts.json" > "$CREDS/home/.cezar/agent-accounts.json.tmp" \
     && mv "$CREDS/home/.cezar/agent-accounts.json.tmp" "$CREDS/home/.cezar/agent-accounts.json"

   # 3. the same shaped task, again with NO agentProfile on the body
   RUN2=$(curl -fsS -X POST "$API/p/$PROJ/runs" -H 'content-type: application/json' \
          -d '{"task":"park on the waitable fallback","workflow":"quick-task","runner":"claude"}' \
          | tee "$ART/start-waitable.json" | jq -re '.id')
   ```

   Poll to a 120s deadline with the same `kill -0 "$(cat "$ART/server.pid")"` guard, writing
   `$ART/run-waitable.json` each iteration, until the record reads `queued` **and**
   `$REPO_REAL/.ai/cezar/runs/$RUN2.ndjson` carries a `run.account_fallback` line; fail immediately
   if `$ART/claude.run` appears, if `$ART/codex.run` grows, or if the status reaches `done`,
   `failed` or `cancelled`, each of which means it was not parked. **`running` is NOT a failure
   here**, and asserting it were would flake: admission sets `running` before `executeRun` gets to
   the placement, and `holdRunOnAccount` is what puts the record back to `queued` and clears
   `startedAt` (`run.ts:3655-3660`). The pass is the settled state, not the first state seen. Then:

   ```sh
   cp "$REPO_REAL/.ai/cezar/runs/$RUN2.ndjson" "$ART/events-waitable.ndjson"
   jq -e '.status == "queued"' "$ART/run-waitable.json"
   jq -se '[.[] | select(.name == "run.account_fallback")] as $m
           | ($m | length) >= 1
           and ($m[0].type              == "metric")
           and ($m[0].site              == "explicit-reroute")
           and ($m[0].requestedRoute    == "default")
           and ($m[0].requestedProvider == "claude")
           and ($m[0].requestedAccount  == "claude:default")
           and ($m[0].selectedProvider  == "codex")
           and ($m[0].selectedAccount   == "codex:codex-fixture")
           and ($m[0].selectedTier      == "waitable")
           and ($m[0].cause             == "credentials")' "$ART/events-waitable.ndjson"
   jq -se '[.[] | select(.type == "note"
                         and (.message | test("waits on codex:codex-fixture")))] | length >= 1' \
           "$ART/events-waitable.ndjson"
   test "$(wc -l < "$ART/codex.run")" -eq "$CODEX_RUNS_BEFORE"   # parked, NOT spawned
   test ! -e "$ART/claude.run"
   ```

   Every field is read off `rerouteExplicitAccountIfUnavailable` on `origin/main`
   (`run.ts:3193-3280`). `requestedRoute` is
   `formatAgentRoute({kind:'account', accountId:'default'})`, which is the bare string `default`
   (`agent-route.ts:83-86`). `tier` is `waitable` because `runnable` is empty (both discovered
   defaults are logged out under the shims, and the only other account is now quota-limited) while
   the current account is `disconnected`, so `pool = waitable` (`run.ts:3228-3231`) and
   `tier = pool === runnable ? 'runnable' : 'waitable'`. `cause` is `credentials` because
   `currentTier === 'disconnected'`. The note is the second branch's exact wording,
   `<account> is logged out, so this task waits on <target> instead` (`run.ts:3255-3260`).
   `holdRunOnAccount` then parks the run **unconditionally** at `queued`
   (`run.ts:5411-5419`, `:3648-3666`), deliberately without consulting `accountHeldOn`, which is
   why `codex.run` must not grow: a park runs nothing. The metric assertion is `>= 1`, not `== 1`,
   and reads `$m[0]`: a parked run stays in the queue and a later re-admission attempt would append
   a second, identical metric, which is correct behaviour and must not fail the assertion.

   **This step therefore proves a different site from step 6, on purpose, and the spec says so
   rather than blurring them.** Acceptance criterion 5's scenario is step 6's `pool:*` dispatch;
   the `waitable` tier is a real part of the feature spec's contract that only the explicit route
   can reach today. The two claims are not interchangeable and neither substitutes for the other.
   Step 9 clears `selections` outright, so no restore is needed between here and there.
9. **The terminal case:** rewrite `agent-accounts.json` with an empty `accounts` array **and clear
   `selections`**, with no accounts there is no pool to resolve, `resolvePoolForDispatch` answers
   `undefined` (`agent-route-select.ts:270`), and the pre-flight gate is what answers. Re-probe,
   then assert `409` and the exact string
   `No agent provider is authorized. Connect one in Settings → Agents → Providers.`
   Then the quiet-queue check: inventory `find "$CREDS/home/.cezar" "$REPO_REAL/.ai/cezar" -name '*.ndjson' -printf '%p %s\n' | sort`
   before and poll the diff to a 60s deadline, failing on the **first** write rather than a minute
   later. Paths and byte counts, so a file that gained lines fails as loudly as one that appeared.
   No **new** run `.ndjson` appears, because a refusal happens before run creation; the two files
   from steps 6 and 8 are in the baseline inventory and must not grow.
10. **Teardown explicitly, then prove production was undisturbed:** close the browser session, call
    `cleanup`, disarm the trap, assert `$SRV` is gone and `$CREDS` is removed, then take the
    after-measurements. `$ART` is retained.

    **Byte-identical `providers/status` is NOT the gate.** This is a shared, live box: account
    probes fire on their own cadence and a runtime auth failure can legitimately re-stamp cached
    provider status while V6 is running, so an equality check there fails for reasons that have
    nothing to do with this phase, and it would tempt the report toward explaining the diff away.
    The evidence that production was undisturbed is that **the live service is the same process
    running the same release, and the live stores were not written**:

    ```sh
    # 1. same release, same process: nothing was deployed and nothing restarted
    curl -fsS http://127.0.0.1:4321/api/v1/ready | jq -r '.deploy.releaseId'   # == $LIVE_RELEASE
    systemctl show cezar.service -p MainPID --value                            # == $LIVE_PID
    # 2. the live stores were not written (captured identically before step 3)
    sha256sum /var/lib/cezar/.cezar/agent-accounts.json                        # == the before hash
    # the SAME six paths as the step 2 baseline, in the same order, so the two files diff cleanly
    stat -c '%n %Y' /var/lib/cezar/.cezar/agent-accounts.json /var/lib/cezar/.cezar/config.json \
         /var/lib/cezar/.claude /var/lib/cezar/.claude-secondary \
         /var/lib/cezar/.codex  /var/lib/cezar/.codex-secondary 2>/dev/null
    ```

    All four must match their pre-phase values, and the `stat` list must be **all four credential
    homes**, not the two codex ones: this box runs a secondary login for claude as well (step 2).
    A directory mtime bounds the blast radius rather than proving byte-level immutability, and the
    report states it that way. **`agent-account-usage.json` is deliberately not on
    that list**: it carries the workspace-wide dispatch cursor and in-flight counts and is rewritten
    by every real run on this box (measured: mtime moved twice in the ten minutes this spec was
    being reviewed), so requiring it unchanged would be requiring the box to be idle.

    `live-before.json` and `live-after.json` are still captured and still retained, as
    **diagnostics**. Quote the `diff -u`; a difference is investigated and explained in the report
    (which provider row moved and why), not treated as a phase failure on its own.

Deliverable: `$ART` retained, its path quoted, and the assertions' output quoted in the run report.
V6 is not complete with step 7 skipped.

### P3. Two in-repo corrections, one proposal plus handoff, and the todo stays open (stop-safe: last phase)

**Renamed 2026-08-29 (second review).** The phase used to be called "correct the record in place,
and close the todo", and neither half of that is achievable by this run: the one document acceptance
criterion 4 names lives on a **read-only mount**, and there is no apply path on `origin/main` for
the proposal that is the only sanctioned way to correct it (c). So this phase makes the two
corrections it can make, writes the proposal, hands the exact replacement text to the owner, and
reports criterion 4 as a **blocker** with todo `21e18103` left open.

Two of the four items are in-repo edits, each with an editor tool and an anchored replacement, never
a whole-file rewrite. The third is a proposal. The fourth is the reindex that makes the third
visible.

**a. The feature spec's status block** (`.ai/specs/2026-08-25-logged-out-account-fallback.md:3-8`).
The falsehood is in the status line itself, so amend it there: record the deploy release id, record
V6 and V7 as run with their date and the `$ART` path, and drop `QA Needed` **only if** P1 and P2
both passed in full including P2 step 7 (the browser case). If anything was skipped, the status
says exactly what. The release id is `$LIVE_RELEASE` as measured in P0, never a literal from this
document.

**b. The same spec's V6 step 4**, marked `CORRECTED 2026-08-29`, recording that
`CODEX_FIXTURE_HOME` / `LIVE_CODEX_HOME` are withdrawn, that no dedicated codex home exists on this
box, that the scalar guard fails open where two live homes exist, and that the connected half is
now staged with `CEZ_CODEX_BIN`. Original text kept below the lead-in, unchanged.

**c. The corpus changelog `notion-3979979f15e0`, as a KB PROPOSAL, not as a direct file edit.
CORRECTED 2026-08-29 (review).** The first draft told the implementer to open
`/var/lib/cezar/loki-labs/notion-export/changelog/2026-08-25-account-fallback-instead-of-blocking-dispatch--local.md`
and edit it with anchored replacements. That is the one thing the active knowledge-base rule
forbids: *"To record a durable decision, or correct a stale one, append NDJSON lines to
`CEZ_KB_WRITE_FILE`, never edit a mounted document directly."* The document is in the **`notion`**
root, which is a read-only mount from cezar's point of view. So the correction is written as a
proposal, as follows.

**`seq` is computed, never literal. CORRECTED 2026-08-29 (second review):** the earlier draft
computed `NEXT` and then wrote `"seq":0` and `"seq":1` into the two operations anyway, so a resumed
turn, or any earlier turn that had already appended to this file, would write duplicate sequence
numbers into it. `seq` counts up across **every** line appended this run, so read what is there and
continue from it:

```sh
: "${CEZ_KB_WRITE_FILE:?}"   # this run: .ai/cezar/runs/<task-id>.knowledge.ndjson
: "${CEZ_TASK_ID:?}"
NEXT=0
# `if`, not `[ -f … ] && …`: under `set -e` the false arm of that AND-list aborts the script.
if [ -f "$CEZ_KB_WRITE_FILE" ]; then
  NEXT=$(grep -c '' "$CEZ_KB_WRITE_FILE")   # counts a final unterminated line too
fi
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "NEXT=$NEXT"
```

Two operations, in this order, one JSON object per line, both **generated** so `seq` cannot drift
from `NEXT`:

```sh
NEW=changelog/2026-08-29-logged-out-account-fallback-landed-and-deployed.md

jq -nc --argjson seq "$NEXT" --arg run "$CEZ_TASK_ID" --arg now "$NOW" \
       --arg path "$NEW" --arg body "$BODY" \
  '{op:"upsert",scope:"workspace",path:$path,
    title:"Logged-out account fallback: landed, deployed, and verified on the box",
    type:"note",tags:["cezar","deploy","verification-doctrine"],
    supersedes:["notion-3979979f15e0"],
    body:$body,seq:$seq,runId:$run,createdAt:$now}' >> "$CEZ_KB_WRITE_FILE"

NOTE=$(cat <<'TXT'
"Fixed and merged to main; not yet deployed" and "Still open: the deploy, and the spec's live
on-box V6 and V7 checks" were both true on 2026-08-25 and are both false now.
TXT
)
jq -nc --argjson seq "$((NEXT + 1))" --arg run "$CEZ_TASK_ID" --arg now "$NOW" --arg by "$NEW" \
       --arg note "$NOTE" \
  '{op:"supersede",target:"notion-3979979f15e0",by:$by,date:"2026-08-29",amendHeading:true,
    note:$note,seq:$seq,runId:$run,createdAt:$now}' >> "$CEZ_KB_WRITE_FILE"

# assert the two seqs are exactly NEXT and NEXT+1, in that order, on the right ops
jq -rs --argjson a "$NEXT" --argjson b "$((NEXT + 1))" \
  'if (.[-2].seq == $a and .[-2].op == "upsert"
       and .[-1].seq == $b and .[-1].op == "supersede") then "seq ok"
   else error("seq or op mismatch: \(.[-2].op)/\(.[-2].seq) then \(.[-1].op)/\(.[-1].seq)") end' \
  "$CEZ_KB_WRITE_FILE"
```

`$BODY` is composed first, in the shell, from the values P0 measured: the release id, its activation
time, the V6 and V7 outcomes, and the `$ART` path.

`amendHeading: true` because the falsehood is in the bolded lead-in the entry opens with, which is
what a reader scanning the changelog carries away, doctrine's own rule for a correction whose
falsehood is in the heading. The body must name the **measured** `$LIVE_RELEASE` from P0, never a
literal copied out of this spec: it was `20260829T110133Z-a04cda25` at writing and
`20260829T111523Z-17637629` twelve minutes later.

**A proposal is not the record, and on `origin/main` there is no path by which this run can apply
it. CORRECTED 2026-08-29 (second review):** the earlier draft said "if the proposal can be applied
in this session, apply it", which is a branch with no true arm. Four measurements, all against
`origin/main`, all read today:

- **The HTTP apply route always refuses.** `POST /api/v1/knowledge/proposals/apply` exists, checks
  the run, reads its proposals, and then answers `{applied: [], refused: [{seq, reason}]}` with
  `reason: 'applying knowledge proposals is not implemented yet'` for every seq that exists
  (`packages/cezar/src/server/knowledge-routes.ts:239-257`, the constant at `:68`). The module doc
  at `:39-48` calls this a "deliberate partial fill-in": `applied` stays empty until the applier is
  wired in.
- **The cockpit has no apply mutation** to call it with: `git grep -n proposals packages/web/src`
  on `origin/main` returns nothing.
- **Even the internal applier would refuse this particular document.** `applySupersede` resolves
  the target in the catalog and returns `{ok: false, reason: 'target is on a read-only mount'}`
  unless `entry.root` is `project` or `workspace`
  (`packages/cezar/src/knowledge/proposals.ts:186-193`). `notion-3979979f15e0` is on the **`notion`**
  root, which is neither.
- **`cez kb write` cannot reach it either**, for the same reason from the other end: it resolves a
  root from `scope`, which is only `project` or `workspace` (`proposals.ts:107`).

So the honest plan is **propose, then hand off**:

- write the two NDJSON lines, run `CEZ_KB=1 cez kb proposals` from `/var/lib/cezar/loki-labs`, and
  quote its output, so the proposal is visible to whoever applies it;
- in the same handoff, hand the owner the **exact anchored replacement text** for the stale
  `Fixed on a branch, not yet landed` lead-in and the `Not done` paragraph of
  `/var/lib/cezar/loki-labs/notion-export/changelog/2026-08-25-account-fallback-instead-of-blocking-dispatch--local.md`,
  with the measured release id already substituted in, so the authorized corpus-side edit is a paste
  rather than a re-derivation. **This run does not make that edit**: the corpus doc is a mounted,
  read-only root from cezar's point of view and the active knowledge-base rule forbids editing a
  mounted document directly;
- report acceptance **criterion 4 as NOT met**, as a named blocker, with the four measurements
  above as its reason. The change stays `QA Needed` on that criterion and todo `21e18103` stays
  **open**. Writing a proposal is not correcting a record, and neither is describing what the
  correction would have said.

Anything written under `/var/lib/cezar` in this phase is written **as `cezar`**, never
root-then-`chown`. End with `find /var/lib/cezar -not -user cezar | wc -l`, which must print `0`.

**d. Reindex and verify, because a corpus write is not a knowledge-base write until it is indexed.**
Nothing holds a `KnowledgeStore` open on the `loki-labs` project, so its watcher never fires:

```sh
cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb reindex
CEZ_KB=1 cez kb search "logged-out account fallback landed"    # what the reindex can prove today
CEZ_KB=1 cez kb show notion-3979979f15e0                       # expected: STILL reads as current
```

**What the reindex can and cannot prove. CORRECTED 2026-08-29 (second review).** Until the
authorized corpus-side application in (c) has actually happened, a reindex proves only that the
corpus is indexed as it stands. `cez kb show notion-3979979f15e0` reading as **current** is therefore
the *expected* result of this phase, reported as such, and not a failed check: nothing has yet
rewritten that document, by design. Run the reindex anyway, because on this box a corpus write is
not a knowledge-base write until it is indexed, and because the moment the correction is applied the
same three commands become the pass condition without change.

Once it has been applied, the pass condition is `cez kb search` returning the corrected entry as
**current** and `notion-3979979f15e0` no longer reading as current, not the presence of a line in
`catalog.ndjson`. If you do grep the catalog, grep the **slug or path**, never the document's prose:
the catalog stores an excerpt, so a phrase-grep returns `0` for a correctly indexed document.

Todo `21e18103` is **not** closed by this run: criterion 4 is open by (c), which is a blocker, not a
judgement call. Leave `541c8214` alone as well: it is a separate question about model defaults, not
about this branch.

### Not a phase: deploy

The feature is live (M2) and both targets are `manual: true` (M7). No phase here runs
`server-deploy` or `activate-main.sh`. If this run's own commit needs activating, the deploy step
parks with a handoff card, which is the expected terminal state, and one human activation of
`origin/main` clears it along with every other parked run.

---

## Risks

- **R1. `origin/main` moves under the gate.** It moved twice while this spec was written. P0 pins a
  sha and every claim names it; a gate on an unnamed "main" proves nothing later. If main advances
  mid-phase, the pin is still the honest subject of the report.
- **R2. A stray `CEZ_DRY_RUN` makes P1 pass vacuously.** The single most likely way to report an
  unearned green: it forces every auth read to connected and unstages all four V7 cases. Mitigated
  by `env -u` on every gate command and by echoing the absence of both variables into the log.
  Detection: if V7's cases all pass in under a second, suspect it.
- **R3. The isolated server reads live credentials anyway.** The whole point of `env -i`. Detection
  is built in: under correct isolation **both** provider default rows read not-connected, and a
  `connected` default row means the isolation leaked and the run must stop. The `live-before` /
  `live-after` diff is the second, independent check.
- **R4. The E2E fixture escapes cleanup.** Precedent exists on this box
  (`2026-08-25-disposable-e2e-fixture-containment.md`). Mitigated by splitting `$ART` from
  `$CREDS`, arming the trap before the first write, guarding the `kill`, calling `cleanup`
  explicitly and asserting `$CREDS` is gone.
- **R5. The shim takes an unexpected branch and a case passes for the wrong reason.** Mitigated the
  way the packed test does it: three separate logs, and `codex.other` must be empty. A shim that
  silently took the wrong arm shows up as an empty `codex.run` or a non-empty `codex.other`.
  **Two branches the packed test never needs, and this phase does** (P2 step 3): `--version`, which
  `detectEnvironment()` fires at **both** binaries from `GET /health`
  (`core/backend-detect.ts:37-44`, `:68-70`) and which the packed shim would have dumped into
  `codex.other` while exiting `1`, breaking this very mitigation and reporting codex unavailable;
  and `$CODEX_HOME`, without which one shim answers "connected" for both codex profiles and
  `selectedAccount` becomes a coin flip.
- **R5b. The two sites get confused for each other, and one is reported as the other.** Setting the
  project's claude selection to `"default"` routes through `rerouteExplicitAccountIfUnavailable`
  and emits `site: "explicit-reroute"` (`run.ts:3263-3274`), which is a real fallback but not the
  one criterion 5 names. **P2 now exercises both, deliberately and in that order** (second review):
  step 6 dispatches on `pool:*` and is criterion 5's evidence; step 8 switches to the explicit
  default because the `waitable` placement is unreachable from a pool route at all (see step 8's
  three citations). Mitigated by asserting `site` and `requestedRoute` **by value** on each run,
  `pool` / `pool:*` in W5 and `explicit-reroute` / `default` in step 8, so neither result can be
  filed under the other's claim.
- **R6. The deviation hides a real defect in credential parsing.** Accepted and stated: V6 no longer
  covers "a genuine codex login parses as connected". That is provider-CLI behaviour, exercised
  continuously by the live service, and orthogonal to the selection logic under test. If the owner
  wants it covered, the answer is a dedicated third codex login on the box, which is an owner
  action and a separate, small piece of work.
- **R7. The browser cannot launch as `cezar` despite the binary being installed.** M6 proves
  `agent-browser --help` runs, not that it can start Chrome for Testing headless under this user in
  this session. If step 7 cannot run it is reported as a **skip**, V6 is incomplete and the change
  stays `QA Needed`; it is not absorbed into a pass. A first launch may also need to download
  Chrome for Testing; if the box has no egress to that host, that is the same skip with a
  different cause, and the report names which.
- **R7b. The correction is written but never applied, and the report calls the record fixed.** The
  KB rule routes a correction through `$CEZ_KB_WRITE_FILE` as a **proposal**, and `cez kb` has no
  `apply` (measured 2026-08-29). Writing the NDJSON is not correcting the record. Mitigated by P3(d)
  verifying through `cez kb search`/`cez kb show` rather than through the file, and by the explicit
  rule that an unapplied proposal is a blocker on criterion 4 rather than a completed criterion.
- **R8. The run-scoped assertions are written against the wrong event shape.**
  `run.account_fallback` is a `metric`, and at the pool site it is emitted only when something was
  skipped. An assertion written against a `note`, or against a fixture with nothing to skip, fails
  for a reason that has nothing to do with the feature. Mitigated by quoting the payload in Data
  models.
- **R9. Correcting the record by appending.** Doctrine's most-repeated failure here: the stale
  lead-in stays readable as current and is what the next session reads first. Mitigated by naming
  the exact anchors in P3 and by amending the heading where the falsehood is in the heading.

---

## Verification

Concrete and executable. Each item names the acceptance criterion it discharges. Every one of them
either produces quoted output or is a stop.

**W1 (criterion 1, strongest available reading).** `PIN` recorded, `d385cd5c` proven an ancestor of
it, and the five-gate sequence green **twice** on a clean checkout of `PIN`, environment-scrubbed.
Quote both runs' final lines, including the test-file and test counts.

```sh
git rev-parse origin/main                                     # -> PIN, recorded
git merge-base --is-ancestor d385cd5c "$PIN" && echo ok       # must print ok
env | grep -E 'CEZ_DRY_RUN|CEZ_AGENT_MODELS_LOCKED' ; echo "scrub_rc=$?"   # want no output
```

**W2 (criterion 3).** `config-api.test.ts` is **green** on `PIN`. Quote the line. If it is red,
stop, and prove its state on the merge base before saying anything about causation. Under no
circumstance is it filed as "the known unrelated failure" without that proof, because the fix
`fe4287c2` is on main and the expected state is green.

**W3 (criterion 2, V7).** `npm run test:package` exits `0` on `PIN`. **Quote the top-level test's
result line and the suite summary**: that is the available evidence, and it is enough.

**CORRECTED 2026-08-29 (review): the first draft's post-test log inspection is impossible, and its
"four named tests" do not exist.** Read from `packages/cezar/test/e2e/package-cli.test.ts` on
`origin/main`:

- The whole file is **one** top-level `test(…)`, `'the release tarball installs and runs the
  dry-run CLI workflow'` (`:19`). V7's four cases are **anonymous `{ … }` scopes** inside it
  (`:405`, `:427`, `:452`, `:492`), so the runner's output names one test, not four. Requiring
  four named passes would make a correct green run read as a failure.
- The test's `finally` block is `await rm(root, { recursive: true, force: true })` (`:517-519`),
  and `shimDir` is `join(root, 'provider-shims')` (`:288`). So `codex.probe.log`, `codex.run.log`
  and `codex.other.log` **are deleted before the process exits**. `<shimDir>` does not exist after
  `npm run test:package`, and every `grep` against it fails on a passing run.

The non-vacuousness the deleted logs were meant to prove is already asserted **inside** the test,
while the files still exist, at `package-cli.test.ts:419-424`:

```
assert.ok(probed.length > 0, 'codex was probed');
assert.ok(ran.length > 0, 'codex was actually dispatched to, not just probed');
assert.equal(other, '', 'the codex shim never took an unrecognised branch');
```

Cite those three lines, and rely on W1's environment scrub (`CEZ_DRY_RUN` /
`CEZ_AGENT_MODELS_LOCKED` both unset) for the vacuity risk they cover. Retaining the shim logs
would mean editing `package-cli.test.ts` to split V7 into named subtests and keep `root` on
failure, a real improvement, and **out of scope here**: this run changes no production code and no
test. If it is wanted, file it as a follow-up.

**W4 (criterion 2, V6).** `$ART` exists after the run and contains, at minimum:
`artifact.sha256`, `server.pid`, `server.log`, `ready.json`, `health.json`,
`live-ready-before.json`, `live-pid-before`, `live-stores-before.sha256`,
`live-stores-before.mtimes`, `live-before.json`, `live-after.json`,
`project.json`, `projects.json`, `providers.json`, `codex-fixture.json`,
`repo-real`, `start.json`, `run.json`, `history.json`, `events.ndjson`,
`start-waitable.json`, `run-waitable.json`, `events-waitable.ndjson`,
`refused.json`, `claude.probe`, `codex.probe`, `codex.run`,
`composer-state.json`, `browser-snapshot.json`, `thread-text.json`,
`composer.png`, `thread-after-send.png`. Quote the listing. A missing file is a step that did not
run, and the report must say which. There is **no** `video/` and no `events.json`; see M6 and the
Data models section.

**W5 (criterion 5).** The dispatch proof, from `$ART/run.json` (a **raw** `RunRecord`) and
`$ART/events.ndjson` (the run's own append-only event file):

```sh
jq -e '.runner       == "codex"'                         "$ART/run.json"
jq -e '.agentProfile == "codex-fixture"'                 "$ART/run.json"
jq -e '[.steps[].profileId] | any(. == "codex-fixture")' "$ART/run.json"
jq -se '[.[] | select(.name == "run.account_fallback"
                      and .type            == "metric"
                      and .site            == "pool"
                      and .requestedRoute  == "pool:*"
                      and .cause           == "credentials"
                      and .selectedProvider == "codex")] as $m
        | ($m | length) >= 1
        and ($m[0].skippedDisconnected | index("claude:default") != null)' "$ART/events.ndjson"
test ! -e "$ART/claude.run"      # THE assertion: nothing ever ran on the dead login
```

All five must exit `0`. Note what changed from the first draft and why each would have failed a
correct run: **no `.run.` prefix** (`GET /p/:project/runs/:id` answers the record itself,
`server.ts:5361-5365`); **`.ndjson`, not `events.json`** (`/runs/:id/events` is an indefinite SSE
stream, `server.ts:6484-6510`); and **`requestedRoute == "pool:*"`**, which is what makes this the
acceptance criterion's scenario rather than the explicit-account one. `claude.probe` **existing**
is expected and correct: probing a logged-out account is fine, running on it is the bug.

**W6 (production was not disturbed).** **CORRECTED 2026-08-29 (review): a byte-identical
`providers/status` is not the gate.** This box is shared and live; probes fire on their own cadence
and a runtime auth failure can re-stamp cached provider status during V6, so equality there can
fail for reasons unrelated to this phase, and a report that has to explain the diff away has
already lost the argument. The gate is that the live service is the **same process running the same
release** and that the live stores were **not written**:

```sh
curl -fsS http://127.0.0.1:4321/api/v1/ready | jq -r '.deploy.releaseId'  # == $LIVE_RELEASE (P0)
systemctl show cezar.service -p MainPID --value                           # == $LIVE_PID   (P0)
sha256sum -c "$ART/live-stores-before.sha256"                             # agent-accounts.json unchanged
diff -u "$ART/live-stores-before.mtimes" <(stat -c '%n %Y' \
  /var/lib/cezar/.cezar/agent-accounts.json /var/lib/cezar/.cezar/config.json \
  /var/lib/cezar/.claude /var/lib/cezar/.claude-secondary \
  /var/lib/cezar/.codex  /var/lib/cezar/.codex-secondary 2>/dev/null)
test ! -e "$CREDS"
find /var/lib/cezar -not -user cezar | wc -l                              # 0
```

All must pass. **All four live credential homes are in that list, not two**: this box runs both
`.claude` and `.claude-secondary` alongside `.codex` and `.codex-secondary` (measured 2026-08-29),
and an earlier draft stat'd only the codex pair, so a write into a claude home would have gone
unnoticed by the gate that exists to notice it. **State the strength of the check honestly in the
report:** the `sha256sum` line proves `agent-accounts.json` is byte-identical; the `stat` lines
prove only that no entry was created, renamed or removed in those four directories, since a
directory mtime does not move when a file inside it is rewritten in place. That is a blast-radius
bound, not proof of unchanged contents, and it is deliberately where this phase stops reading.
`agent-account-usage.json` is deliberately excluded: it holds the workspace-wide dispatch cursor
and is rewritten by every real run on this box. `diff -u "$ART/live-before.json"
"$ART/live-after.json"` is still run and still quoted, as a **diagnostic**: if it is non-empty,
name which provider row moved and why, and do not fail the phase on it alone.

**W7 (criterion 4, the record).** After P3:

```sh
# the two NDJSON operations were written, with CONTINUOUS `seq` counted from what was already
# there (P3(c)), never the literals 0 and 1
grep -c '' "$CEZ_KB_WRITE_FILE"                  # want $((NEXT + 2))
jq -rs --argjson a "$NEXT" --argjson b "$((NEXT + 1))" \
  'if (.[-2].seq == $a and .[-2].op == "upsert"
       and .[-1].seq == $b and .[-1].op == "supersede") then "seq ok" else error("seq mismatch") end' \
  "$CEZ_KB_WRITE_FILE"
cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb proposals   # both operations visible for review

# the reindex, and what it is expected to show TODAY
CEZ_KB=1 cez kb reindex
CEZ_KB=1 cez kb search "logged-out account fallback landed"
CEZ_KB=1 cez kb show notion-3979979f15e0     # expected: STILL current, because nothing applied it

# ownership, every session that touches the box
find /var/lib/cezar -not -user cezar | wc -l    # want 0
```

The release id the corrected entry must name is `$LIVE_RELEASE` **as measured in P0**, not a
literal from this document: it changed once (`…110133Z-a04cda25` to `…111523Z-17637629`) in the
twelve minutes between this spec being written and being first reviewed.

**W7 does not have a passing form for criterion 4 in this run, and says so rather than leaving a
branch open.** Measured 2026-08-29 on `origin/main`: `POST /knowledge/proposals/apply` refuses every
seq with `applying knowledge proposals is not implemented yet`
(`server/knowledge-routes.ts:239-257`), the cockpit has no mutation that calls it, and
`applySupersede` refuses a `notion`-root target as a read-only mount (`knowledge/proposals.ts:186-193`).
So W7 passes on the **proposal** half (the two lines exist, with continuous `seq`, and are listed by
`cez kb proposals`) and reports criterion 4 as a **blocker** on the application half, with
`cez kb show notion-3979979f15e0` still reading as current as the honest evidence of it. Todo
`21e18103` stays open. Only an authorized corpus-side application makes the last three commands a
pass, and that is a follow-up handoff, not something this run can do.

**W8 (definition of done).** The feature spec's status block no longer claims V6 and V7 are unrun,
no longer claims the change is undeployed, and either drops `QA Needed` or states precisely what is
still outstanding. **Todo `21e18103` stays open regardless of W1 through W6**, because W7's
application half cannot pass in this run (the apply route refuses, and the target is a read-only
mount), so acceptance criterion 4 is a reported blocker rather than a met criterion. If any step
was skipped, it is named in the report and in the status line, and the change stays `QA Needed`.

---

## Out of scope

- **Re-litigating the design.** Tiers, message copy, the two sites that keep blocking, and the
  disabled-provider ruling are settled in `.ai/specs/2026-08-25-logged-out-account-fallback.md` and
  KB `notion-eb0154f0fbb7`. Nothing here reopens them.
- **Any behaviour change.** This spec's phases add no production code. The only repository edits
  are the two in-place corrections in P3.
- **Activating a deploy.** Manual by owner decision (M7).
- **Todo `541c8214`** (native claude model default missing from `defaultModels`). A separate
  question, still open, deliberately untouched.
- **Provisioning a dedicated codex login on the box.** That is the only thing that would restore
  V6's original credential fixture, it is an owner action, and R6 records the coverage it would
  add.

## Open questions

1. **Does the owner want a third, dedicated codex login on the box**, so V6 can assert on a real
   credential rather than a shim? Not needed for any assertion in this spec; it would only widen
   coverage to provider-CLI parsing. Left as a question rather than assumed either way.
2. **Should `origin/main` be activated after P1 goes green**, so production catches up the two
   unrelated commits it is behind (M3)? The feature does not need it, and activation is a human's
   call about a quiet board. Flagged, not scheduled.
