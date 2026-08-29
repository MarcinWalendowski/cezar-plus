# Verify Active Backlog Tables

- **Status:** **CORRECTED 2026-08-29 (same run) — Phases 1-3 implemented, not "no code written."**
  The candidate-condition launch probe (D2/D3) landed in `.ai/scripts/test-env-up.sh`
  (Phase 1); the boot and gate (Phases 2-3) ran for real: `sh .ai/scripts/test-env-up.sh`
  booted past the hosted-no-auth gate, and
  `npx vitest run --config packages/web/e2e/vitest.config.ts filed-partitions` passed, writing
  all seven artifacts to `.ai/qa/artifacts_e2e/` (five PNGs, `filed-partitions-verdict.json`,
  `filed-partitions-deployed-requests.json`). The verdict matches Verification item 4 exactly:
  `initial = {active: 20, backlog: 30}`, both `appendedOnly`/`*Unchanged` true, both `showMore`
  analytics events present, request-phase counts `2/1/1/1/1` with the expected `partition` and
  `fasort`/`fbsort` query keys on each. This work was committed alongside the spec text itself in
  `3e6f77c2` ("docs: split the Active/Backlog E2E verification into its own spec" — a misleading
  message for a commit that also shipped the harness fix and ran the gate), merged into
  `origin/main` as `54ff9bc1`, confirmed a direct ancestor of `origin/main`'s current tip.
  **Not yet run: Phase 4 (§10a, the deployed-bytes check against the live `/opt/cezar` bundle)**
  — `filed-partitions-deployed-requests.json` on disk still reads `deployed: false` with
  `serverCli` pointing at this worktree's own build, not `/opt/cezar/packages/cezar/dist/index.js`,
  so that check has not executed even once. **Not run, and not an agent step: §10b, the owner's
  authenticated pass on `https://cockpit.example.com`** (`AGENTS.md:614-622`). Both are tracked as
  todo `7e35a93d-18ec-4afc-a5b3-eaaac14a1a0b`. **Until both close, this is QA Needed, not Done.**
  See Results below for the full numbers. Original text, kept for the record:
  ~~Specified (no code written by this step)~~
- **Date:** 2026-08-29
- **Task:** `265c2695-f524-4a40-b0e8-d613cf1a31fd`, workflow `spec-to-deploy`, branch `cez/265c2695`
- **Brief:** step 1 of this run left one at
  `/var/lib/cezar/loki-labs/cezar/.ai/specs/briefs/2026-08-29-finish-active-backlog-tables-qa.md`
  (13,334 bytes, 2026-08-29T14:08Z). **It is not a resolvable citation and must not be read as
  one:** it exists only in the shared checkout, is **untracked there** (`git status` reports it as
  `??`), and is absent from this worktree, so it is not on any branch and nothing carries it
  forward. Every claim this spec makes is therefore cited against a **primary** source that IS in
  the tree: a file path with a line range, a commit sha, a schema, or a measurement taken on this
  box and reported inline.
- **Completes:** `.ai/specs/2026-08-25-split-active-backlog-tables.md`, that spec's Verification
  steps **9** (browser E2E) and **10** (production runtime pass), the only two of its eleven that
  have never executed. That document stays the **design** record for the feature; this one is the
  **verification** record, following this repo's own precedent for splitting the two
  (`.ai/specs/2026-08-25-verify-bulk-start-release.md`,
  `.ai/specs/2026-08-29-verify-logged-out-fallback.md`).
- **Task statement (verbatim, unchanged from the original run):** "On /tasks, Active appears above
  Backlog with 20 and 30 rows initially. Independent Show more controls add exactly 10 rows. Every
  sortable column requests deterministic backend ordering with a stable tie-breaker and preserves
  status partitions during expansion. Contract, server, and UI tests cover columns, partitions,
  limits, increments, and invalid queries. Analytics ship, and browser E2E artifacts prove both
  sections, one sort in each, and both expansions."

## TLDR

The feature is built, gated, merged and pushed (`18206411`, `ebdedb6c`, both on `origin/main`).
Ten of its eleven acceptance clauses are already met by landed tests. The eleventh, *"browser E2E
artifacts prove both sections, one sort in each, and both expansions"*, is unmet.

**The recorded reason for that is wrong, and this spec's first job is to correct it in place.**
The record says the browser provider "is not installed", citing the absence of
`$HOME/.cache/agent-browser`. That is the wrong path. `ensure_browser()` caches the binary at
`$CACHE_ROOT/agent-tools/agent-browser/` (`.ai/scripts/test-env-up.sh:259-260`), and measured on
this box on 2026-08-29:

```
-rwxr-xr-x 1 cezar cezar 13933968 Aug 21 21:39
  /var/lib/cezar/.cache/agent-tools/agent-browser/agent-browser-linux-x64
$ agent-browser-linux-x64 --version
agent-browser 0.34.0
```

The provider is here, and it is a working executable. `doctor --json` exits **1** with
`{"fail":1,"pass":8,"warn":0}`: eight checks pass, including `chrome.installed`, *"Google Chrome
for Testing 152.0.7977.64 at /var/lib/cezar/.agent-browser/browsers/chrome-152.0.7977.64/chrome"*,
`net.chrome_cdn` reachable, and 534.5 GB free. The single failure is `launch.launch`:

> Browser launch failed: Chrome exited early ... `FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox!`
> ... **Hint: try `--args "--no-sandbox"` (required in containers, VMs, and some Linux setups)**

So the blocker is not a missing provider. It is the **launch environment**, and the tool prints its
own fix. Measured, four runs, each with its own `--session` and a `close` between them:

| # | Chrome sandbox flag | `TMPDIR` | Result |
| --- | --- | --- | --- |
| 1 | none | `/tmp/abt` (8 chars) | FAIL, `No usable sandbox!` |
| 2 | `--args "--no-sandbox"` | inherited worktree tmp (87 chars) | FAIL, `FATAL:chrome/browser/process_singleton_posix.cc:313] Socket path too long: .../org.chromium.Chromium.Go2OVt/SingletonSocket` |
| 3 | `--args "--no-sandbox"` | `/tmp/abt` | **PASS** |
| 4 | `AGENT_BROWSER_ARGS=--no-sandbox` | `/tmp/abt` | **PASS** |

Two conditions, each independently necessary, jointly sufficient. Under condition 3/4 the whole
operation set this task needs works: `navigate https://example.com` returns
`{"success":true,...,"title":"Example Domain"}`, `screenshot` writes a 15,001-byte PNG, and
`snapshot` returns an accessibility tree with `[ref=e1]` handles.

**So agent-browser is the provider for this task, and Playwright is resilience work, not the
blocker.** The spec's shape follows from that:

1. **Discover the launch conditions by probe and record them in the descriptor** (D2). Not a knob:
   `ensure_browser()` already probes, it just gives up after the first failure and never tries the
   fix its own tool printed.
2. **Fix the boot.** `.ai/scripts/test-env-up.sh` spawns `cezar serve` with the agent's inherited
   environment, which carries `CEZ_PUBLIC_URL`, enough on its own to put the instance in hosted
   mode, where `auth-boot-gate.ts` refuses to boot. `AGENTS.md:626-634` documents the fix and
   explicitly rules out the escape the last session named: *"Do not reach for credentials, a
   service token, or `CEZ_ALLOW_UNAUTHENTICATED=1`"*. Two boot sites need it, not one (D8).
3. **Stop hard-coding the provider name** in six places, so the descriptor, the emitted lines and
   every diagnostic agree on what actually resolved (D3).
4. **Then run the suite** (`filed-partitions.e2e.ts`, already written, 10,409 bytes, never
   executed), producing the screenshots, the verdict JSON, and a request log that proves the
   two-request design (D6), plus one assertion that analytics reach disk (D7).
5. **Playwright behind the same seam is a separate, later, optional phase** (D4). It is worth
   having, because a second provider is the difference between "this box can run E2E" and "this
   box can run E2E as long as one vendored binary keeps working", but nothing in this task waits
   on it.

## Problem

1. **The one unmet acceptance clause is a browser run, and no artifact exists.** The design spec's
   Verification §9 names five PNGs and `filed-partitions-verdict.json` under `.ai/qa/artifacts_e2e`.
   That directory does not exist: `.ai/qa/` holds `.build-cache`, `.gitkeep`, `test-env-app.log`
   and `test-env-build.log`, and no `test-env.json`. The design spec's own Implementation notes say
   so: *"Step 9's browser E2E is written ... but was NOT executed here"*, and *"a spec that says so
   cannot round its own skipped E2E up to one."*

2. **The recorded reason is wrong on the browser half and incomplete on the boot half.**
   - *Recorded:* *"`~/.cache/agent-browser` does not exist so `AgentBrowser.open()` refuses."*
     **Wrong path, wrong conclusion.** See the TLDR: the binary is cached at
     `$HOME/.cache/agent-tools/agent-browser/`, it runs, and its one failing check has a documented
     fix. What is true is the *mechanism*: `ensure_browser()` sets `BROWSER_INSTALLED=1` only when
     `"$BROWSER_COMMAND" doctor --json` exits `0` (`test-env-up.sh:301-310`), doctor exits `1`
     here, so the descriptor honestly records `installed: false` with
     `notes: "live browser launch failed after autonomous install"`, and `e2e.sh` skips. The
     harness measured correctly. The record drew the wrong conclusion from the skip.
   - *Recorded:* `test-env-up.sh` refuses to boot, and *"the documented escape is
     `CEZ_ALLOW_UNAUTHENTICATED=1`, which is a security decision ... not one this task takes."*
     That framing has no documented alternative, so it reads as a dead end. `AGENTS.md:626-634`
     gives the alternative in as many words, and names this exact failure: *"`CEZ_PUBLIC_URL`
     alone is enough to put a fresh instance into hosted mode... That message is not an invitation
     to set `CEZ_ALLOW_UNAUTHENTICATED=1`"*, and instead: *"unset the inherited vars and it boots
     as an ordinary local cockpit. **This is also why `npm run test:e2e` fails on this box rather
     than skipping.**"*

3. **`ensure_browser()` gives up at the first failure.** It has four `return 0` exits (unsupported
   target, download failed, no downloader, and the implicit fall-through after a failed doctor)
   and none of them tries anything else. On this box the last one fires with a Chrome that is
   installed and a hint in the JSON it just threw away. A probe that stops at the first negative
   result is not a probe, it is a single test with extra steps.

4. **Two boots need the environment scrub, not one.** `test-env-up.sh` boots the shared env
   (`start_app()`, `:318-331`), and `filed-partitions.e2e.ts` boots **its own** server through
   `fixtureServeEnv` (`packages/web/e2e/agent-browser.ts:60-65`), which spreads `...process.env`
   verbatim. Fixing only the shared boot leaves the spec's own server hitting the same refusal.

5. **The blockage is systemic, not this feature's.** `npm run test:e2e` has never produced a pass
   on `prod-host`. A second task is stuck at exactly the same wall: todo
   `214b32df-1609-454b-b475-c96e708dbbc8`, *"Correct stale bulk-start spec headers and get a clean
   production E2E verdict"*, status `todo`, read directly from `.ai/cezar/todos.json` in the shared
   checkout on 2026-08-29. Fixing the harness once is worth more than two bespoke driver scripts,
   and a bespoke script would leave `.ai/qa/artifacts_e2e` populated by something that is not the
   suite the spec names.

6. **"Analytics ship" is currently proven only in jsdom.** `packages/web/src/lib/analytics.test.ts`
   and `global-tasks.test.tsx:2066-2122` assert the three events against a mocked client. The
   server half writes NDJSON to `<CEZ_HOME>/analytics/events.ndjson`
   (`packages/cezar/src/workspace/analytics-log.ts:1-24`), and the E2E already pins `CEZ_HOME`
   inside its own `dataRoot`, so a real browser run can read the file back and prove the whole
   path. Nothing does that today, and it costs three lines.

7. **The sort assertions as written can pass without the sort ever arriving.**
   `useWorkspaceTodoPage` sets `placeholderData: keepPreviousData`
   (`packages/web/src/api/queries.ts:2528-2535`), which is deliberate and correct for the UX: the
   current rows stay on screen until the wider page arrives. It also means a test that waits only
   for an unchanged row count and an `aria-sort` attribute is asserting on the **old** rows plus a
   header the client flipped optimistically. `filed-partitions.e2e.ts:182-201` does exactly that.

8. **The production pass has an authorization ceiling an agent cannot cross.** Design spec §10 asks
   for a network tab on `https://cockpit.example.com`. `AGENTS.md:614-622` is explicit: the
   production cockpit is behind Cloudflare Access, loopback is redirected to
   `example.cloudflareaccess.com`, `GET /api/v1/workspace/runs-index` on loopback answers `401`,
   and *"you must not try"* to get past it. So §10 as literally written is not an agent step. It
   has to be split into the part an agent can prove and the part only the owner can.

## Solution

### D1. A verification spec, not an edit to the design spec

Running an already-written E2E is not a scope change, so the *design* spec must not be reopened for
it, but this run does change code (`test-env-up.sh`, `e2e.sh`, `agent-browser.ts`,
`filed-partitions.e2e.ts`, `.env.example`, `README.md`), which is multi-file work, and this
workspace's rules put multi-file work behind a spec. The precedent is already in this directory
twice (`2026-08-25-verify-bulk-start-release.md`, `2026-08-29-verify-logged-out-fallback.md`): the
design spec keeps the decisions, the verification spec keeps the evidence. When this one's phases
land, `2026-08-25-split-active-backlog-tables.md`'s status line and its Verification §9/§10 get a
one-line **in-place** pointer here (per the workspace correction rule), not a rewrite.

### D2. Discover the launch conditions by probe, record them in the descriptor

The provider is present and its Chrome is present. What is missing is two facts about *how* Chrome
must be started here, and neither is a preference:

- **`--no-sandbox`.** Chrome's zygote host aborts with `No usable sandbox!` on this kernel. The
  box has `kernel.unprivileged_userns_clone = 1` and `user.max_user_namespaces = 114830`, so the
  restriction is AppArmor's userns profile rather than the sysctl, which is exactly the case
  Chromium's own error text describes. agent-browser accepts the flag two ways, both measured
  working: the `--args "--no-sandbox"` CLI flag and the `AGENT_BROWSER_ARGS=--no-sandbox`
  environment variable.
- **A short `TMPDIR`.** Chromium builds its process-singleton socket at
  `$TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket`, which adds 45 characters to whatever
  `TMPDIR` is. A Unix socket path is capped by `sun_path` at 108 bytes, and this run's inherited
  `TMPDIR` is 87 characters
  (`/var/lib/cezar/loki-labs/cezar/.ai/cezar/tmp/265c2695-f524-4a40-b0e8-d613cf1a31fd`), so the
  singleton path is 132 and Chrome aborts before it ever writes `DevToolsActivePort`. This is a
  property of **every cezar task worktree**, not of this one: the tmp directory is named after the
  task uuid.

**The environment variable, not the flag.** `AgentBrowser.run()` builds argv as
`['--session', session, ...args, '--json']` (`packages/web/e2e/agent-browser.ts:101-106`) and that
grammar is a contract shared with the descriptor and with any future provider. Threading a
`--args` string through it would change the contract for every operation. `AGENT_BROWSER_ARGS`
changes nothing about the grammar and was measured to work identically (matrix row 4).

**How it reaches the child.** `run()` calls `execFileSync` with no `env` option, so the browser
child inherits the vitest worker's environment. That is too implicit to rely on. Two changes:

- `EnvDescriptor.browser` gains **`env: Record<string, string>`**, the launch conditions the probe
  measured. It is discovered state written into a file cezar already writes, not configuration a
  user must author: exactly what `AGENTS.md` § Zero config permits (*"New state may be written,
  never required"*), and on a Mac, where neither condition applies, the probe records `{}` and
  nothing changes.
- `run()` passes `env: { ...process.env, ...env.browser.env }`.

**The probe, in `ensure_browser()`.** After the binary is resolved (unchanged), and instead of the
single `doctor --json` that decides everything today:

1. Close any existing session first. Every measured `open` reported `"reused": true` against one
   `launchHash`, and `doctor` reports a socket directory at `/run/user/999/agent-browser`, so
   agent-browser keeps a background daemon and **the first launch's environment is the one that
   sticks**. A daemon started under the wrong conditions answers happily and hides the problem.
   This is why matrix row 2 (correct flag, wrong `TMPDIR`) still had to be run in its own session.
2. Try candidate condition sets in order, stopping at the first that produces a **real launch**,
   not a passing doctor:
   `{}`, then `{AGENT_BROWSER_ARGS: '--no-sandbox'}`, then `{TMPDIR: <scratch>}`, then both.
3. The launch probe is `<bin> --session cez-probe-$$ open about:blank --json` followed by
   `<bin> --session cez-probe-$$ close --json`, asserting `success: true`. `doctor --json` is
   still run once for the diagnostic text it produces, and its failing check's message goes into
   `BROWSER_NOTES` when every candidate fails, so a machine that genuinely cannot launch says why.
4. `BROWSER_INSTALLED=1` only when a real `open` succeeded. This is **stronger** than today's gate,
   not weaker: today a doctor that passes every check but a launch that fails for a
   condition doctor does not exercise would still be recorded as installed.

The scratch `TMPDIR` is `mktemp -d /tmp/cez-e2e.XXXXXX` (18 characters, leaving 90 bytes of
headroom), recorded in the descriptor so the E2E and any later reuse use the same one, and removed
by `test-env-down.sh` alongside the rest of the environment. If `/tmp` is itself unusable the
candidate simply fails and the next one is tried, which is the same degradation path as every
other arm.

**Nothing here is a knob.** No new environment variable is read from the user, no config key is
added, `.ai/agentic.config.json`'s `browser.provider` is untouched. Every value is measured on the
machine that will use it and written to a file that is regenerated on every boot.

### D3. Every place the provider is named as a constant, and the reuse path that would break

Six sites spell `agent-browser` literally, so a run resolved to anything else, today or after D4,
would boot correctly and then describe itself wrongly, including in the one message a future
session reads when it fails. This list is exhaustive: it is `grep -rn agent-browser` across
`.ai/scripts/`, `.ai/browsers/` and `packages/web/e2e/`, minus the descriptor document itself.

| File | Line | Hard-coded today | Must become |
| --- | --- | --- | --- |
| `.ai/scripts/test-env-up.sh` | 33 | `BROWSER_DESCRIPTOR=".ai/browsers/agent-browser.md"` | set by `ensure_browser` to the resolved provider's descriptor |
| `.ai/scripts/test-env-up.sh` | 153 | `BROWSER_PROVIDER=agent-browser` inside `emit()` | `BROWSER_PROVIDER=$BROWSER_PROVIDER`, the resolved name |
| `.ai/scripts/test-env-up.sh` | 374 | `provider: "agent-browser"` in the descriptor JSON | a new `$BROWSER_PROVIDER` argv slot, written through |
| `.ai/scripts/e2e.sh` | 26-28 | skip banner: *"The agent-browser provider (.ai/browsers/agent-browser.md) could not be provisioned here"* | name what was tried and why each was rejected, since "agent-browser is missing" was never the whole reason and on this box is not the reason at all |
| `.ai/scripts/e2e.sh` | 59, 61 | `"agent-browser is unavailable"` fallback notes | `"no browser provider is available"` |
| `packages/web/e2e/agent-browser.ts` | 92 | `` `cezar e2e: the agent-browser provider is not installed (${env.browser.notes})` `` | name `env.browser.provider`, falling back to `"none"` when nothing resolved |
| `packages/web/e2e/agent-browser.ts` | 108, 112 | `` `cezar e2e: agent-browser ${args.join(' ')} failed` `` and `` ... → ${JSON.stringify(parsed.error)}` `` | both read the resolved provider |

Lines 108 and 112 are in `run()`, which is **every operation's** error path, so fixing `open()`
alone leaves every subsequent failure mislabeled. `AgentBrowser` therefore stores the resolved
provider name alongside `bin` and `session` in its constructor and uses it in all three throws.

`EnvDescriptor` (`packages/web/e2e/agent-browser.ts:28-31`) types `browser` as
`{ installed, command, version, notes }` while the script already writes a `provider` field the
type does not admit. It gains `provider: string` and `env: Record<string, string>`.

**The reuse path, which would otherwise break under `set -u`.** `try_reuse()` returns `0` at
`test-env-up.sh:189` **before** `ensure_browser()` ever runs, and it restores exactly one browser
value, `BROWSER_INSTALLED` (`:186-187`). So changing `emit()` to print `$BROWSER_PROVIDER` would
print an unset variable on the reuse path, and under this script's `set -u` that is a hard failure,
not a blank. Equally, a descriptor written before this change carries no `browser.env`, and reusing
it would run the browser under the conditions that do not work. Required behaviour:

- `try_reuse()` restores `BROWSER_PROVIDER`, `BROWSER_COMMAND`, `BROWSER_VERSION`,
  `BROWSER_DESCRIPTOR` and `BROWSER_ENV` from the descriptor alongside `BROWSER_INSTALLED`.
- A descriptor missing **any** of them (the pre-change shape) fails the reuse check and falls
  through to a full `ensure_browser()`. Missing is treated as "not validated", never as empty.
- When `BROWSER_INSTALLED` is restored as `1`, the launch is **revalidated** with the same cheap
  `open about:blank` / `close` probe under the restored `BROWSER_ENV`. A descriptor is a claim; the
  script already applies that rule to the app (*"A state file is a claim, not proof"*, `:174`) and
  it applies no less to a browser whose scratch `TMPDIR` may have been reaped by tmpfiles.
- Revalidation failure demotes to `installed: false` with a note, and the descriptor is rewritten.
  It never silently reuses.

**The invariant this exists to enforce:** the resolved provider name, its descriptor path, its
command, its env conditions, the `browser.*` values in `.ai/qa/test-env.json`, the
`BROWSER_PROVIDER=` line `emit()` prints, and every human-readable message must all agree, on every
path, including reuse and including the skip path where nothing resolved. Verification 3 asserts
that agreement rather than assuming it.

### D4. A second provider behind the seam, as resilience, deferred

`packages/web/e2e/agent-browser.ts:1-12` states the seam's own contract: *"Every e2e spec drives
the app through this module and never through a browser library directly... Swapping providers must
mean rewriting this file only."* `AgentBrowser.open()` takes the executable path from the
descriptor's `browser.command` and shells it with a fixed argv grammar, so **a provider is an
executable that speaks that grammar**, and adding one needs no change to any of the 19 `*.e2e.ts`
files that drive it.

This is worth building and it is **not** on this task's critical path. It ships as Phase 5, after
the artifacts exist, or not at all. What follows is the design, corrected, so that the phase can be
picked up without re-deriving it, and so that D3's provider-neutrality has something concrete to be
neutral about.

**Resolution order** in `ensure_browser()`, once Playwright exists as an arm:

| Order | Arm | Chosen when | Costs network |
| --- | --- | --- | --- |
| 1 | existing `agent-browser` | on `PATH` or in the tool cache **and** a launch probe passes under some candidate condition set (D2) | no |
| 2 | existing Playwright | `require('playwright')` resolves **and** a Chromium launch probe passes | no |
| 3 | provision `agent-browser` | neither of the above exists at all | yes, GitHub Releases |
| 4 | none | everything failed | no |

Order 1 before 2 because 19 specs were written and reviewed against agent-browser's snapshot
format, so a box that has a working one keeps behaving identically. **Provisioning moves to last**,
which is a change from today: `ensure_browser()` currently downloads before it has looked at what
is already on the machine. And **every** agent-browser failure path continues to the next arm
rather than `return 0`, which is Problem 3's fix. Order 4 records `installed: false` and `e2e.sh`
skips loudly, exactly as today.

**Why a Playwright provider is a detached broker, not a script.** This is the non-obvious part, and
the obvious design does not work. `AgentBrowser`'s methods are synchronous because `execFileSync`
makes them so, which is fine, a separate process may be internally async and still block its
caller. The real problem is **browser lifetime**: every operation must find the page the previous
operation left behind, and the process that issued it has exited. Measured in the installed copy,
`/usr/lib/node_modules/playwright/node_modules/playwright-core/lib/coreBundle.js`:

- `launchProcess()` calls `addProcessHandlerIfNeeded("exit")` **unconditionally** (`:8959`) and adds
  the browser to `killSet` (`:8964`).
- `exitHandler()` is `for (const kill of killSet) kill()` (`:8857-8860`).

So the browser is killed by the launching process's own `exit` handler. `detached: true` does not
help: that flag is already set on the browser's spawn (`:8904`), and the kill is issued by the
parent before it exits regardless. A short-lived `open` that calls `chromium.launchServer()`
destroys the browser about a millisecond after writing the endpoint, and the next invocation
connects to nothing. Two further defects in that design, independent of the first: a browser
reached over `connect()` starts with no contexts and no pages, so `context.pages()[0]` is
`undefined` on the first call; and `launchServer` disposes the contexts a connection created when
that connection disconnects.

**The design that works:**

- **The broker** (`.ai/scripts/playwright-broker.cjs`) is spawned by the CLI with
  `spawn(process.execPath, [broker, session], { detached: true, stdio: 'ignore' })` then
  `child.unref()`. A new process, so Playwright's exit handler lives inside it and fires when the
  broker exits, which is when the browser should die.
- It calls `chromium.launch()`, creates one `BrowserContext` and one `Page`, and holds all three
  for the session. Nothing reconnects, so nothing is disposed.
- **Socket path.** The root is `process.env.XDG_RUNTIME_DIR || os.tmpdir()`, computed in Node, not
  in shell. The shell form `${XDG_RUNTIME_DIR:-$TMPDIR}` is wrong: under D6's `env -i` **both**
  names are absent, the expression collapses to the empty string, and the socket root becomes
  `/cezar-playwright`, which `cezar` cannot create. `os.tmpdir()` falls back to `/tmp` on its own.
- **Session ids are filenames, so they are validated.** `/^[a-zA-Z0-9._-]{1,32}$/` or the CLI exits
  non-zero before touching the filesystem. Unvalidated they are both a path-traversal vector
  (`--session ../../x`) and a `sun_path` overflow, the same 108-byte cap D2 already tripped over.
  The assembled path is asserted under 100 bytes before `listen()`.
- The directory is created `0700`, the socket `0600`. A socket rather than a `wsEndpoint` because
  it needs no port, is filesystem-permissioned, and its absence is an unambiguous "no broker".
- **The CLI** (`.ai/scripts/playwright-browser.cjs`, the executable the descriptor names) parses
  the argv grammar, connects, writes one newline-delimited JSON request, reads one response, prints
  it, exits. It holds no Playwright objects, which is why its exit kills nothing.
- **Startup race.** On `open` the CLI connects; on `ENOENT`/`ECONNREFUSED` it spawns the broker and
  retries on a bounded loop (100ms interval, 30s ceiling). Never a fixed `sleep`. A socket that
  exists but refuses connection is a dead broker: unlink and respawn.
- **`close`** closes the browser, unlinks the socket, exits `0`. The CLI never throws on `close`,
  because the seam's `close()` already swallows (`agent-browser.ts:242-248`) and teardown must not
  mask a real failure.
- **Orphan bound.** The broker self-exits after 10 minutes with no command, so a `SIGKILL`ed suite
  leaves at most one browser for at most ten minutes.

**Resolution is CommonJS-only, and the extension is load-bearing.** `AGENTS.md:548-560`: the bare
`require('playwright')` works from any cwd because `$HOME/.node_modules` symlinks into
`/usr/lib/node_modules` and Node consults it through its global-folder lookup, **which does not
apply to ESM**, and this repo is `"type": "module"`. Hence `.cjs`.

**[correcting AGENTS.md]** Only *one* of the two symlinks resolves. Measured 2026-08-29:
`require.resolve('playwright')` returns `/usr/lib/node_modules/playwright/index.js`, while
`require('playwright-core/package.json')` throws `MODULE_NOT_FOUND`, because the real package is
nested at `/usr/lib/node_modules/playwright/node_modules/playwright-core`. The broker must
`require('playwright')` and take `chromium` off it. `AGENTS.md` § Headless browser gets a one-line
in-place correction saying so.

Per the same section: **never set `PLAYWRIGHT_BROWSERS_PATH`.** `PLAYWRIGHT_` is in neither
`BASE_ALLOW_NAMES` nor `BASE_ALLOW_PREFIXES` in `packages/cezar/src/core/agent-env.ts`, so it is
dropped before any agent child starts and every launch then fails with nothing pointing at the
cause. Browsers stay at `$HOME/.cache/ms-playwright`, present here with `chromium-1234`,
`chromium_headless_shell-1234`, `firefox-1538`, `webkit-2336` and `ffmpeg-1011`.

**The sandbox almost certainly applies to Playwright too, and this is not measured.** The
`No usable sandbox!` abort is a property of the kernel and AppArmor profile, not of agent-browser,
so a Playwright arm will need `chromium.launch({ chromiumSandbox: false })` or the same
`--no-sandbox` arg. Not verified here, because no Playwright launch was attempted while writing
this spec. Phase 5's first act is to measure it, and the D2 candidate-probe pattern is what it
should reuse rather than assuming.

**Snapshot compatibility, if the arm is built.** There is no `page.accessibility` in Playwright
1.62.1. The operation maps to `await page.ariaSnapshot({ mode: 'ai' })` (`types.d.ts:2062`),
returned as `data.snapshot`, the key `AgentBrowser.snapshot()` already reads (`:124`). The format
is not byte-compatible with agent-browser's and no compatibility is claimed. Bounded, not
hypothetical: `grep -rln '\.snapshot()' packages/web/e2e/` returns nothing across all 19 specs, and
`filed-partitions.e2e.ts` never calls it. Because nothing exercises it, it is the one operation
that could ship broken invisibly, so Phase 5's provider test calls it explicitly and asserts a
non-empty string containing `[ref=e`.

### D5. What this spec gates on, and what it merely reports

The changes in D2, D3 and D8 are to the **shared** boot and the **shared** launch environment, so
they affect every spec in `packages/web/e2e/`, not only the one this task needs. A harness change
that breaks the suite it is meant to enable is this spec's own defect. But gating on the
correctness of 18 specs this task did not write, none of them ever exercised on this box, would
make completion depend on product behaviour nobody here changed. So the line is drawn by **cause**:

- **Gate (must be green before Phase 4 ships):**
  1. `filed-partitions.e2e.ts` passes, and its artifacts exist and are non-empty (five PNGs, the
     verdict JSON, and the request log D6 adds).
  2. **Every failure caused by this change is fixed.** A launch condition that works for one spec
     and not another, a descriptor field a spec reads and this change reshaped, a timeout the
     scrubbed environment introduces: all of it blocks. There is no "known harness gap" allowance.
- **Report and file, do not gate:** only a failure *independently confirmed* to be a stale spec or
  an unrelated product defect. Independently confirmed means proven not to be the harness, and the
  proof is written into Results: the spec's assertion checked against what the app actually does
  now, by hand or by a targeted probe against the same running server. "It looks unrelated" is not
  confirmation. Each one is filed as its own todo with `cezar todo add`, quoting the failing
  assertion, never silently absorbed here.
- **Ambiguous counts as caused by this change.** The alternative is a harness that quietly weakens
  the whole suite and reads as if it strengthened it.

The full suite is run once for this triage, and its per-file pass/fail table goes verbatim into
Results with each failure's category and evidence beside it.

### D6. The production pass, split at the authorization line

Design spec §10 as written is not executable by an agent (Problem 8). Split.

**§10a, the deployed bytes, provable here.** Measured 2026-08-29:

- Live is `95b93175eeba9304904a7713934307b12c9eb701`
  (`GET http://127.0.0.1:4321/api/v1/ready` → `deploy.sha`).
- This branch's HEAD is `ebdedb6c679c0efb02b24ec033f496a58291555c`, and
  `git merge-base --is-ancestor ebdedb6c 95b93175` **exits 0**. Everything at this HEAD is in the
  running process.
- `/opt/cezar/packages/cezar/dist/workspace/todo-ordering.js` exists (4,151 bytes, mtime 14:03),
  which is the pure ordering module this feature introduced and which did not exist before it.
- `filedPartition` appears in the deployed server tree in `contract/index.js`,
  `contract/workspace-todos.d.ts` and `workspace/todo-index.js`.
- In the deployed web bundle, `fbsort` and `fasort` each appear in exactly one asset under
  `/opt/cezar/packages/cezar/web/dist/assets/`.

**Correcting the earlier draft of this section, which cited bundle strings that are not there.** It
claimed the bundle contains `filed-backlog-table` and `filed-active-section`. Measured across all
203 assets: **zero** files contain either, and zero contain `filedPartition`. They are not missing
features, they are assembled at runtime, `filed-${partition}-table` in the spec's own selectors
(`filed-partitions.e2e.ts:147`) and equivalently in the component. Only `fbsort` and `fasort`
survive minification as literals. So the deployed-byte evidence is **ancestry plus
`todo-ordering.js` plus the `fbsort`/`fasort` literals plus the deployed browser run itself**, and
a grep for a runtime-assembled string is not evidence of anything.

Two things had to change for the step to be executable at all:

1. **`page.on('request')` is unreachable through the seam.** `AgentBrowser` exposes 15 synchronous
   one-shot operations and no event subscription, and adding one would mean an async callback
   surviving across process boundaries. Request observation is instead **provider-neutral and
   pull-based**, through the `evaluate` operation the seam already has:
   `performance.getEntriesByType('resource')` filtered on `/workspace/todos`. A browser API, not a
   Playwright API, so it works identically under any provider.
2. **The E2E hard-codes the local build.** `cezarCli` is
   `resolve(repoRoot, 'packages/cezar/dist/index.js')` (`packages/web/e2e/agent-browser.ts:26`),
   imported by **19** `*.e2e.ts` specs (20 files including the seam itself), among them
   `filed-partitions.e2e.ts:129`. It becomes
   `process.env.CEZ_E2E_SERVER_CLI ?? resolve(repoRoot, 'packages/cezar/dist/index.js')`: one line,
   one file, default unchanged, all 19 call sites untouched.

**The scenario, exactly.** `filed-partitions.e2e.ts` gains a request-log helper called at five
points, clearing between each so counts are per-interaction and not cumulative. The two sort phases
are new, and they are the fix for Problem 7:

| Phase | Clear before | Wait for | Expect |
| --- | --- | --- | --- |
| `load` | `clearResourceTimings()` immediately before `goto` | both tables at 20 and 30 rows | `2` requests, one `partition=active`, one `partition=backlog` |
| `sort-active` | after the load counts are read | Active's rows equal the fixture's expected priority order, exactly | `1` request, `partition=active`, `fasort=priority`, ascending |
| `sort-backlog` | after the active sort is asserted | Backlog's rows equal the fixture's expected task order, exactly | `1` request, `partition=backlog`, `fbsort=task`, ascending |
| `expand-active` | after the sort phases | Active reaches 30 rows | `1` request, `partition=active`, `limit=30` |
| `expand-backlog` | after the active expansion | Backlog reaches 40 rows | `1` request, `partition=backlog`, `limit=40` |

Counts are **`2 / 1 / 1 / 1 / 1`**.

Three things this changes about the existing assertions:

- **Wait for the data, not the header.** Because of `keepPreviousData`, `aria-sort` flipping and
  the row count staying at 20 are both true the instant the click lands, before any response
  arrives. Each sort phase therefore waits on the **exact expected row sequence** for the fixture's
  seeded data and only then takes its screenshot. The current
  `filed-partitions.e2e.ts:182-201` waits on `aria-sort` alone.
- **Assert the request's own query.** One request with `partition=active` proves the other
  partition's key was not refetched, which is the claim the whole two-request design rests on
  (design spec D3). Counting requests without reading their URLs does not.
- **`rowIds()` records the composite key.** It reads `data-todo-id` alone today
  (`filed-partitions.e2e.ts:146-148`). A workspace board is cross-project and the row carries
  **both** attributes (`packages/web/src/routes/global-tasks.tsx:1703-1704`), so a todo id is not a
  row identity here. It becomes `` `${data-project}:${data-todo-id}` ``, which is what makes
  "appended only" and "unchanged" mean what they say.

The log is folded into `filed-partitions-verdict.json` under `requests` on every run, local or
deployed, so the local run proves the assertion works before the deployed run is asked to trust it.

**The command.** Run as `cezar`, never root.

```bash
set -u
B=$(mktemp -d /tmp/cez-deployed.XXXXXX)
trap 'rm -rf "$B"' EXIT
mkdir -p "$B/cez-home" "$B/tmp"

# The descriptor is what AgentBrowser.open() reads; without it the run dies in beforeAll.
sh .ai/scripts/test-env-up.sh
node -e 'const d=require("./.ai/qa/test-env.json");
         if(!d.browser||!d.browser.installed) {console.error("no browser provider");process.exit(1)}'

env -i PATH="$PATH" HOME="$HOME" SHELL=/bin/sh TERM="${TERM:-dumb}" LANG="${LANG:-C.UTF-8}" \
    TMPDIR="$B/tmp" \
    CEZ_HOME="$B/cez-home" \
    CEZ_ANALYTICS=1 \
    CEZ_E2E_SERVER_CLI=/opt/cezar/packages/cezar/dist/index.js \
    npx vitest run --config packages/web/e2e/vitest.config.ts filed-partitions
```

Three corrections to the earlier draft of this command, each of which made it fail:

- **`HOME` is preserved, not replaced.** The earlier `HOME=$B/home` broke everything that depends
  on the real home: `require.resolve('playwright')` returns `MODULE_NOT_FOUND` without
  `$HOME/.node_modules`, `$HOME/.cache/ms-playwright` disappears, and so does
  `/var/lib/cezar/.agent-browser/browsers`, where the Chrome that D2 measured actually lives. It
  directly contradicted this spec's own D4. Isolation comes from **`CEZ_HOME`** instead, which
  `packages/cezar/src/paths.ts:17-19` documents as overriding the `~/.cezar` base *"so tests (and
  containers) never touch a real"* registry. That is the variable for this job.
- **No fixed `/var/tmp/filed-deployed`, and no unquoted `rm -rf $B`.** A fixed path is a collision
  between two concurrent tasks on a shared box; an unquoted expansion is a foot-gun with a
  destructive verb attached. `mktemp -d` plus a quoted `trap ... EXIT`.
- **`TMPDIR` is scratch and short**, `/tmp/cez-deployed.XXXXXX/tmp`, about 28 characters, for the
  reason D2 measured.

Artifact: `.ai/qa/artifacts_e2e/filed-partitions-deployed-requests.json`, schema in Data models.
Nothing here activates or deploys anything: both `.ai/deploy-targets.json` targets are
`"manual": true` (owner decision 2026-08-24, `.ai/specs/2026-08-24-default-workflow-ten-stages.md`
D6), and this step only reads what a person already activated.

**§10b, the real production cockpit, the owner's.** Both sections with real data on
`https://cockpit.example.com`, behind Cloudflare Access, in the owner's own authenticated session.
The only remaining step an agent may not perform, and the task stays QA Needed until it is done.

### D7. Analytics, proven to disk

`filed-partitions.e2e.ts` gains one assertion at the end of its scenario, after the two expansions:
read `<dataRoot>/.cez-home/analytics/events.ndjson`, parse each line, and assert the run produced at
least one `todo.filed_partition_viewed` for each of `active` and `backlog`, at least one
`todo.filed_sorted`, and exactly two `todo.filed_show_more` with `{from: 20, to: 30}` and
`{from: 30, to: 40}`. Parsed lines are folded into `filed-partitions-verdict.json` under
`analytics`, so "analytics ship" is readable in an artifact rather than asserted in prose. The
client buffer flushes on an idle callback with a 2,000ms timeout
(`packages/web/src/lib/analytics.ts:52-58`), so the assertion polls the file for up to 10s rather
than reading it once.

### D8. The environment scrub is an allowlist, and it covers both boots

The earlier draft carried `AGENTS.md:648-652`'s ten-name `env -u` list as a **deny** list. That is
demonstrably not enough. Measured in this agent's own environment on 2026-08-29:

```
CEZ_ACCOUNT_USAGE  CEZ_ACCOUNT_USAGE_HOSTED  CEZ_AUTO_ACCOUNTS  CEZ_BROWSE_ROOT  CEZ_CLUSTER
CEZ_ENV_PASSTHROUGH  CEZ_HANDOFF_FILE  CEZ_KB  CEZ_KB_ROOTS  CEZ_KB_WRITE_FILE
CEZ_OIDC_CLIENT_ID  CEZ_OIDC_ISSUER  CEZ_PORT_STRICT  CEZ_PROJECTS_DIR  CEZ_PUBLIC_URL
CEZ_REMOTE  CEZ_SESSION_ID  CEZ_STEP_ID  CEZ_TASK_ID  CEZ_TODOS_FILE
```

Twenty variables; the documented list names ten. The seven the deny list misses that actually
change what the fixture server does (`CEZ_CLUSTER`, `CEZ_KB`, `CEZ_KB_ROOTS`, `CEZ_AUTO_ACCOUNTS`,
`CEZ_ACCOUNT_USAGE`, `CEZ_ACCOUNT_USAGE_HOSTED`, `CEZ_BROWSE_ROOT`, plus `CEZ_PORT_STRICT` which
changes how it binds) are exactly the kind that make a run pass here and fail elsewhere. A deny
list is also structurally wrong: it goes stale the next time a variable is added, silently, in the
direction of leaking.

**So both boots build their environment by allowlist, not by subtraction.**

- **Removed:** every `CEZ_*` variable in the inherited environment, without exception, plus
  `NODE_ENV`. Enumerated at runtime from the environment itself, so a variable added next month is
  dropped without anyone editing a list.
- **Restored, explicitly, because the harness sets them deliberately:** `CEZ_DRY_RUN=1`,
  `CEZ_HOME=<the pinned path>`, and `CEZ_ANALYTICS=1`.
- **Restored, because a caller asked for them:** whatever the caller passed as test extras
  (`fixtureServeEnv`'s existing `extra` parameter, `agent-browser.ts:60-65`, and
  `CEZ_SINGLE_PROJECT` in the shell script, which `try_reuse` already keys the descriptor on at
  `:166-168`). A spec that wants a `CEZ_*` variable must name it; it can no longer inherit one.
- **Kept untouched:** everything outside `CEZ_*` that a Node process needs, `PATH`, `HOME`, `LANG`,
  `XDG_*`. `HOME` in particular must survive, because both providers' browser caches are
  `$HOME`-scoped (`/var/lib/cezar/.agent-browser/browsers` and `$HOME/.cache/ms-playwright`).
- **`TMPDIR` and `AGENT_BROWSER_ARGS` are not `CEZ_*` and so are not scrubbed**, but they are the
  D2 launch conditions and must be *set*, not merely left alone. The descriptor's `browser.env` is
  the single source for both, applied by `AgentBrowser.run()` (D2) rather than by each caller.

**`CEZ_ANALYTICS=1` is forced, not merely left alone.** `analytics-log.ts` disables the sink when
`CEZ_ANALYTICS === '0'` exactly. That variable is not set on this box today, but it is inheritable,
one character, and disables precisely the thing D7 asserts. Leaving it to chance would make D7
non-deterministic, and the failure would read as "analytics do not ship" rather than as "the
harness turned them off".

**Both call sites, and neither is optional:** `start_app()` (`test-env-up.sh:318-331`) and
`fixtureServeEnv()` (`agent-browser.ts:60-65`), the latter being the one that actually boots
`filed-partitions.e2e.ts`'s server. Both are covered by a single shared rule stated once in
`fixtureServeEnv`'s doc comment and mirrored in the shell script, so the two cannot drift apart
silently.

## Architecture

```
npm run test:e2e
  └─ .ai/scripts/e2e.sh                        ← CHANGED: skip banner names what was tried
       │                                                 and why each arm was rejected (D3)
       ├─ 1. sh test-env-up.sh
       │      ├─ npm ci + build                 (unchanged)
       │      ├─ try_reuse()                    ← CHANGED: restores provider/command/env and
       │      │                                           REVALIDATES the launch (D3)
       │      ├─ boot cezar on $PORT            ← CHANGED: allowlist boot env (D8)
       │      └─ ensure_browser()               ← CHANGED: candidate-condition launch probe,
       │            │                                     no early return, records what worked
       │            └─ writes .ai/qa/test-env.json
       │                 { baseUrl,
       │                   browser: { provider, command, descriptor, installed, version,
       │                              notes,
       │                              env: { AGENT_BROWSER_ARGS: "--no-sandbox",
       │                                     TMPDIR: "/tmp/cez-e2e.XXXXXX" } } }
       ├─ 2. gate on browser.installed          (unchanged; skip is still NOT a pass)
       └─ 3. npx vitest run --config packages/web/e2e/vitest.config.ts
              └─ filed-partitions.e2e.ts
                   ├─ spawns its OWN cezar (fixture project, 60+60 seeded todos)
                   │    via fixtureServeEnv()   ← CHANGED: same allowlist (D8)
                   │    at cezarCli             ← CHANGED: CEZ_E2E_SERVER_CLI override (D6)
                   ├─ walks the onboarding wizard, ordered and awaited (Risk 4)
                   ├─ five request phases       ← CHANGED: sorts added, URLs asserted (D6)
                   └─ AgentBrowser.open(session)
                        └─ execFileSync(browser.command,
                                        ['--session', id, ...op, '--json'],
                                        { env: { ...process.env, ...browser.env } })  ← CHANGED
                              └─ agent-browser 0.34.0
                                    └─ Chrome for Testing 152.0.7977.64
                                       from /var/lib/cezar/.agent-browser/browsers
```

Deferred, Phase 5 (D4): a `.ai/scripts/playwright-browser.cjs` arm, a thin `node:net` client to a
detached `.ai/scripts/playwright-broker.cjs`, plugged in at the same `browser.command` slot.

Nothing in `packages/contract`, `packages/cezar/src/workspace/`, `packages/cezar/src/server/` or
`packages/web/src/` is touched. The feature is finished; this is all harness and evidence.

## Phases

**These phases are cumulative and stop-safe, not independent.** Stopping after any one of them
leaves the tree green, buildable and better than before, but a later phase depends on the state an
earlier one wrote. Specifically: Phase 2 cannot select a provider until Phase 1 has taught the
probe how to; Phase 3 has nothing to drive until Phase 2 has written a descriptor with
`installed: true`; Phase 4 reads the descriptor Phase 2 produces. The earlier draft claimed each
phase "ships alone", and that was false in three places.

**Phase 1, the launch probe and the provider-neutral descriptor.** `ensure_browser()` gains the
candidate-condition probe and the real-launch gate (D2); the descriptor gains `provider` and `env`;
`try_reuse()` restores and revalidates them (D3); the six hard-coded provider names become the
resolved one (D3's table), including `AgentBrowser.run()`'s two operation-failure throws.
`EnvDescriptor` gains both keys. **Stop-safe:** on its own this makes `npm run test:e2e` boot a
browser on this box for the first time, which is what todo `214b32df` is also waiting on.

**Phase 2, the boot environment.** The D8 allowlist in both `start_app` (`test-env-up.sh:318-331`)
and `fixtureServeEnv` (`agent-browser.ts:60-65`), plus the `CEZ_E2E_SERVER_CLI` override on
`cezarCli` (`agent-browser.ts:26`, D6). **Depends on Phase 1** only in that its verification runs
the same `test-env-up.sh`. **Stop-safe:** after this, `npm run test:e2e` gets past the hosted-mode
refusal.

**Phase 2b, the environment contract, in the same commit as Phase 2.** Mandatory under
`AGENTS.md` § Zero config, which permits state to be written but not required, and which is the
reason every variable that changes behaviour has to be documented where a reader looks for it:

- `.env.example` gains **`CEZ_E2E_SERVER_CLI`** (new here) and **`CEZ_ANALYTICS`** (shipped in
  `abe83105` and never documented). Measured: neither string appears in `.env.example` today.
- `README.md`'s environment table (around `:563`, beside `CEZ_DRY_RUN=1` and `CEZ_AUTONAME=0`)
  gains the user-facing **`CEZ_ANALYTICS`** row. Measured: `grep -n 'CEZ_ANALYTICS' README.md`
  returns nothing. `CEZ_E2E_SERVER_CLI` stays out of the README, which documents the product's
  surface, not the test harness's.

**Phase 3, the run.** Add to `filed-partitions.e2e.ts`: the ordered onboarding walk in `beforeAll`
(Risk 4), the five-phase Resource Timing request log with URL assertions (D6), the composite
`rowIds()` key (D6), the exact-sequence waits that replace the `aria-sort`-only waits (D6), and
D7's analytics assertion. Then run it. Produce the artifacts. Run the full suite once, triage every
failure by cause per D5, fix everything this change caused, and file the rest as todos. **Depends
on Phases 1 and 2.** Ships when D5's gate is green, not before.

**Phase 4, the deployed-bytes pass (§10a).** Run the same spec under D6's exact command. Capture
`filed-partitions-deployed-requests.json`. Nothing is deployed or activated: both
`.ai/deploy-targets.json` targets are `"manual": true` and this step only reads what is already
live. Kill any instance and delete the scratch tree, since *"a stray cockpit on a spare port holds
memory and keeps a worktree lease"* (`AGENTS.md:661-663`). **Depends on Phases 1 to 3.**

**Phase 5, the Playwright arm (D4). Optional, and explicitly not required for this task.** Build it
if the resilience is wanted; skip it and nothing above regresses. Its first act is to measure
whether Playwright's Chromium hits the same sandbox wall, which is currently unmeasured. If it
ships, `AGENTS.md` § Headless browser gets the `playwright-core` dangling-symlink correction as a
bolded in-place lead-in with the original text left below it.

**Phase 6, the record.** Four destinations, and the doctrine differs per destination. Conflating
them is how the last session's knowledge write ended up stale and unapplied.

1. **In-tree, edited in place:** the design spec's status line and its Verification §9/§10 get a
   one-line pointer here; this spec's Results section is filled in with measured numbers;
   `CHANGELOG.md` gets a dated entry.
2. **Corpus status and changelog, written directly** under
   `/var/lib/cezar/loki-labs/notion-export/`, **as `cezar`**, then reindexed. See Verification 11.
3. **Durable knowledge, proposed not written.** Autonomous knowledge writes go through
   `CEZ_KB_WRITE_FILE` as NDJSON proposals, reviewed and applied later through the cockpit or
   `cez kb proposals`; never direct edits to a mounted knowledge document. That file already holds
   **one line, `seq: 0`**, from the previous session, and it is **materially stale**: it names
   `POST /api/v1/workspace/analytics` (that route and its store were deleted in the `ebdedb6c`
   merge; the surviving sink is `POST /api/v1/workspace/analytics/events`), it describes storage as
   `~/.cezar/analytics/YYYY-MM-DD.ndjson` pruned at 30 days (the real sink is
   `<CEZ_HOME>/analytics/events.ndjson`, one-generation rotation to `events.1.ndjson` at
   `ANALYTICS_LOG_MAX_BYTES = 5_000_000`), and it repeats the "the box cannot run the E2E" blocker
   this spec disproves. Phase 6 appends a **`seq: 1` corrected `upsert` for the same `path`**,
   `knowledge/notes/filed-board-active-backlog-split-and-server-ordering.md`, whose body opens with
   a bolded **`CORRECTED 2026-08-29`** lead-in naming what was wrong and leaving the superseded
   text below it unchanged. `seq` counts up across every line appended this run, and **both lines
   remain proposals**: this phase reports the knowledge write as **pending application**, never as
   landed.
4. **The tracker.** The row is `1da9c2bb-fec2-43b9-9f91-4f13eb32fcc4`, *"Split tasks into sortable
   Active and Backlog tables"*, currently `todo`. This tracker's statuses are
   `todo | in-progress | blocked | done`, with **no `qa-needed`**, so the honest end state while
   §10b is outstanding is **`in-progress`**. It becomes `done` only after the owner runs §10b.

## Data models

No product data model changes. Three artifact shapes are contracts of this spec.

**`.ai/qa/test-env.json`**, extended:

```jsonc
{
  "baseUrl": "http://127.0.0.1:<port>",
  "browser": {
    "provider": "agent-browser",          // NEW key on the TS type; the script already wrote it
    "command": "/var/lib/cezar/.cache/agent-tools/agent-browser/agent-browser-linux-x64",
    "descriptor": ".ai/browsers/agent-browser.md",
    "installed": true,                     // now means "a real open succeeded", not "doctor exited 0"
    "version": "agent-browser 0.34.0",
    "notes": "launched with AGENT_BROWSER_ARGS=--no-sandbox and a short TMPDIR",
    "env": {                               // NEW: the measured launch conditions (D2)
      "AGENT_BROWSER_ARGS": "--no-sandbox",
      "TMPDIR": "/tmp/cez-e2e.a1B2c3"
    }
  }
}
```

`env` is `{}` on a machine that needs no conditions, which is the expected value on a Mac.

**`.ai/qa/artifacts_e2e/filed-partitions-verdict.json`**, as the design spec's §9 defines it, with
D6's and D7's blocks. Every id is now the composite `<project>:<todoId>` row key:

```jsonc
{
  "initial": { "active": 20, "backlog": 30 },
  "activeSortedByPriority": ["fixture:act-…", "…"],
  "backlogSortedByTask": ["fixture:bak-…", "…"],
  "activeExpansion":  { "activeBefore": [], "activeAfter": [], "appendedOnly": true,
                        "backlogBefore": [], "backlogAfter": [], "backlogUnchanged": true },
  "backlogExpansion": { "backlogBefore": [], "backlogAfter": [], "appendedOnly": true,
                        "activeBefore": [], "activeAfter": [], "activeUnchanged": true },
  "analytics": {
    "partitionViewed": ["active", "backlog"],
    "sorted": [{ "partition": "active", "column": "priority", "dir": "asc" }],
    "showMore": [{ "partition": "active", "from": 20, "to": 30, "increment": 10 },
                 { "partition": "backlog", "from": 30, "to": 40, "increment": 10 }]
  },
  "requests": { /* the same shape as the artifact below */ }
}
```

**`.ai/qa/artifacts_e2e/filed-partitions-deployed-requests.json`**, new. Written on every run; the
deployed run is distinguished by `serverCli`, which is the point of the artifact:

```jsonc
{
  "serverCli": "/opt/cezar/packages/cezar/dist/index.js",  // or the local dist on a local run
  "deployed": true,                    // serverCli !== the repo's own packages/cezar/dist/index.js
  "liveSha": "95b93175…",              // GET /api/v1/ready → deploy.sha, null for a local build
  "phases": [
    { "phase": "load",           "count": 2,
      "urls": ["…/workspace/todos?partition=active&…", "…/workspace/todos?partition=backlog&…"] },
    { "phase": "sort-active",    "count": 1, "urls": ["…?partition=active&fasort=priority&…"] },
    { "phase": "sort-backlog",   "count": 1, "urls": ["…?partition=backlog&fbsort=task&…"] },
    { "phase": "expand-active",  "count": 1, "urls": ["…?partition=active&limit=30&…"] },
    { "phase": "expand-backlog", "count": 1, "urls": ["…?partition=backlog&limit=40&…"] }
  ],
  "capturedVia": "performance.getEntriesByType('resource'), cleared before each phase"
}
```

Counts are `2 / 1 / 1 / 1 / 1`, and each single-request phase's URL names the partition it acted
on. `capturedVia` is recorded in the artifact rather than only in this spec, so a reader can tell
what the evidence actually is without finding the spec that produced it.

## API contracts

**No HTTP contract changes.** The only wire shapes this spec touches are read-only:

- `GET /api/v1/workspace/todos` with the query added by the design spec: observed, not changed.
- `POST /api/v1/workspace/analytics/events`: the surviving sink from
  `.ai/specs/2026-08-26-filed-task-detail-page.md`, which appends to
  `<CEZ_HOME>/analytics/events.ndjson` (`packages/cezar/src/workspace/analytics-log.ts`). D7 reads
  that file; it does not touch the route.

**New environment variable:** `CEZ_E2E_SERVER_CLI`, read in exactly one place
(`packages/web/e2e/agent-browser.ts:26`), absolute path to a `cezar` CLI entrypoint, defaulting to
this repo's own `packages/cezar/dist/index.js`. Documented in `.env.example` (Phase 2b).

**The provider CLI grammar is a contract, and it is agent-browser's, not a new one:**
`<bin> --session <id> <op> [args…] --json`, printing `{"success":true,"data":{…}}` or
`{"success":false,"error":…}` on stdout, non-zero exit reserved for a crash. `AgentBrowser`
(`packages/web/e2e/agent-browser.ts:98-115`) parses exactly that and throws on `success: false`. A
future Playwright shim that gets this wrong fails loudly on its first call rather than subtly
later.

## Risks

1. **The launch conditions are shared, so a mistake in them breaks all 19 specs at once.** Every
   spec goes through `AgentBrowser`, so `browser.env` is applied to all of them. Mitigated by
   probing rather than assuming (a condition is only recorded if a launch under it succeeded), by
   `env: {}` being the correct and default answer on a machine that needs nothing, and by D5's
   cause-based gate, which makes any failure this change caused blocking. Residual risk is effort,
   not correctness: nobody has ever run the other 18 specs here, so the size of the fix list is
   unknown.
2. **The daemon caches the first launch's environment.** agent-browser keeps a background daemon
   (`env.socket_dir` = `/run/user/999/agent-browser`), and every measured `open` reported
   `"reused": true` against a single `launchHash`. A daemon started under wrong conditions answers
   successfully and hides a broken configuration; a daemon started under right conditions can make
   a broken configuration look fine. Mitigated by D2's rule that the probe closes existing sessions
   first, and by Verification 1 running each candidate in its own `--session`.
3. **A leaked Chrome.** `AGENTS.md:534` names this exact hazard: *"A leaked Chrome under concurrent
   runs is exactly the memory pressure that pushes you to the fallback."* The seam's `afterAll`
   calls `browser.close()`, but a `SIGKILL`ed suite skips it. Phase 3 reports
   `pgrep -fc 'chrome|chromium'` before and after, and a non-zero delta is a failure, not a note.
   Phase 5's broker adds its own 10-minute idle self-exit for the same reason.
4. **The first-run onboarding wizard intercepts `/tasks`, and the earlier draft's walk could not
   work.** The gate is `probe.kind === 'ready' && !probe.hasProjects`
   (`packages/web/src/routes/onboarding/onboarding-gate.ts:101-106`), and `hasProjects` is
   `listProjectTeams({ orgId }).length > 0`, projects **adopted into an org**
   (`packages/cezar/src/auth/onboarding-routes.ts:319-320`). The fixture writes a `projects` entry
   into `config.json` (`filed-partitions.e2e.ts:106-124`) and performs no org adoption, which is
   exactly the state the gate fires on. So the walk is unconditional.

   The earlier draft's instructions were *"fill `[data-slot="onboarding-org-name"]`, click
   `[data-slot="onboarding-org-submit"]`, then navigate to `/tasks`"*, which fails twice: after
   `AgentBrowser.open()` the page is `about:blank`, so there is nothing to fill, and the final
   navigation races the create-organization request. The executable sequence:

   1. `browser.goto(`${baseUrl}/tasks`)` (the gate redirects).
   2. `browser.waitForFunction(...)` on `[data-slot="onboarding-org-name"]` being present.
   3. `browser.fill('[data-slot="onboarding-org-name"]', 'fixture-org')`.
   4. `browser.click('[data-slot="onboarding-org-submit"]')`.
   5. **Wait for a post-creation state**, not for a timer: `[data-slot="onboarding-team-accept"]`
      (`packages/web/src/routes/onboarding/onboarding.tsx:579`) being present, or the URL already
      having left `/onboarding`, whichever the wizard reaches. Both selectors are real and were
      read from the component, not guessed.
   6. `browser.goto(`${baseUrl}/tasks`)` again, then assert `browser.url()` ends in `/tasks`
      **before any table assertion runs**. Otherwise a gate that reappears shows up as "the Active
      table has 0 rows", which reads as a feature bug and is not one.
5. **Scrubbing the environment could remove something a boot needs.** Structural, and answered by
   D8's allowlist rather than by a list to keep current. If a boot then fails for a missing
   variable, the fix is to name that variable in the restore list, a visible reviewable line, not
   to widen the scrub back into a deny list.
6. **The E2E finds a real bug in the feature.** Possible; the feature has never been seen in a
   browser, and D6's stricter sort assertions are exactly the kind that find one. That would be an
   ordinary fix scoped by what the run finds, and it would mean the **design** spec gets amended,
   not this one. Named so it is not treated as this spec failing.
7. **`npm ci` inside a worktree.** The previous session found the worktree had no `node_modules`,
   which made `tsc` silently resolve the main checkout's contract and report a phantom error
   (design spec, Implementation note 1). Phase 1's first act is to confirm `node_modules` exists
   here before trusting any gate output.

## Verification

Every step names its command and its artifact. Nothing here is satisfied by prose.

1. **The launch probe, per candidate** (Phase 1). Each candidate in its own `--session`, with a
   `close` between, because of Risk 2. `$AB` is the resolved command from the descriptor:

   ```sh
   AB=/var/lib/cezar/.cache/agent-tools/agent-browser/agent-browser-linux-x64
   T=$(mktemp -d /tmp/cez-e2e.XXXXXX)
   env TMPDIR=$T AGENT_BROWSER_ARGS=--no-sandbox "$AB" --session v1 open about:blank --json
   env TMPDIR=$T AGENT_BROWSER_ARGS=--no-sandbox "$AB" --session v1 navigate https://example.com --json
   env TMPDIR=$T AGENT_BROWSER_ARGS=--no-sandbox "$AB" --session v1 screenshot $T/v1.png --json
   env TMPDIR=$T "$AB" --session v1 close --json
   ```

   Assert: every call prints `"success":true`; `navigate` reports `"title":"Example Domain"`;
   `$T/v1.png` is non-empty. Then assert the **negative** controls still fail, so the probe is
   proven to be discriminating and not merely lucky: the same `open` without `AGENT_BROWSER_ARGS`
   fails with `No usable sandbox!`, and with `AGENT_BROWSER_ARGS` but
   `TMPDIR=$(pwd)/.ai/cezar/tmp/<task-uuid>` fails with `Socket path too long`. Both were measured
   while writing this spec and must reproduce.
2. **The probe wired into the script** (Phase 1): `sh .ai/scripts/test-env-up.sh`, exit `0`. Then
   read the descriptor rather than the shell, because `sh test-env-up.sh` runs in a **subshell and
   does not populate `$BASE_URL` in the caller**, so a check written against that variable silently
   tests the empty string:

   ```sh
   node -p 'JSON.stringify(require("./.ai/qa/test-env.json").browser, null, 2)'
   ```

   Assert `installed: true`, `provider: "agent-browser"`, `command` ending
   `agent-browser-linux-x64`, `descriptor: ".ai/browsers/agent-browser.md"`, and `env` naming both
   measured conditions. Assert the script printed `BROWSER_PROVIDER=agent-browser` (D3's agreement
   invariant). Then run the script a **second** time and assert it took the reuse path and still
   emitted the same five values, which is the regression D3's `set -u` analysis predicts.
3. **The boot** (Phase 2):
   ```sh
   BASE=$(node -p 'require("./.ai/qa/test-env.json").baseUrl')
   test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/ready")" = 200
   ```
   and the refusal string `hosted mode with no authentication` must not appear in
   `.ai/qa/test-env-app.log`.
4. **The gate** (Phase 3): `npx vitest run --config packages/web/e2e/vitest.config.ts
   filed-partitions`: 1 passed, 0 failed. Then assert on disk, not on the runner's word:
   ```sh
   ls -l .ai/qa/artifacts_e2e/filed-partitions-{both-sections,active-sorted-priority,\
   backlog-sorted-task,active-expanded,backlog-expanded}.png \
        .ai/qa/artifacts_e2e/filed-partitions-verdict.json \
        .ai/qa/artifacts_e2e/filed-partitions-deployed-requests.json
   ```
   All seven present and non-zero. In the verdict JSON: `initial` = `{active:20, backlog:30}`; both
   `appendedOnly` true; both `backlogUnchanged`/`activeUnchanged` true; `analytics.showMore`
   exactly the two objects in D7; every id in every list matching `/^[^:]+:[^:]+$/`, which is what
   proves D6's composite row key actually landed. In the request log (here with `deployed: false`):
   phase counts **`2 / 1 / 1 / 1 / 1`** and each single-request phase's URL carrying the expected
   `partition` and, for the sort phases, the expected `fasort`/`fbsort` key and direction. The five
   PNGs are opened and looked at, not merely counted. Assert `browser.url()` ended in `/tasks`
   (Risk 4).
5. **Analytics to disk** (Phase 3, D7): the assertion inside the spec, plus the `analytics` block
   in the verdict artifact.
6. **Full suite, triaged by cause** (Phase 3, D5):
   `npx vitest run --config packages/web/e2e/vitest.config.ts`. The per-file result table is pasted
   verbatim into Results, each failure categorised as caused by this change / stale spec / product
   bug, **with the evidence written beside the latter two**. Everything in the first category is
   fixed before the phase ships; ambiguous counts as the first category. The other two are filed
   via `cezar todo add`.
7. **No leaked browser** (Phase 3, Risk 3): `pgrep -fc 'chrome|chromium'` before and after; the
   delta must be `0`, and a non-zero delta fails the phase rather than being reported.
8. **Gates green** (Phase 3): `npm run typecheck`, `npm test`, `npm run test:unit`,
   `npm run build`, `npm run test:package`. **All five must exit `0`**, exit codes checked
   individually and final lines quoted. There is **no lint gate in this repository**: no root
   `lint` script, no `eslint.config.*` (design spec, Implementation notes).

   **A red gate stops this change.** The merged tree at `ebdedb6c` measured **12,021 passing, 0
   failing** (run handoff, 2026-08-29T13:55Z). Three failures seen earlier at `97533c88`
   (`workspace/agent-route-step-provider.test.ts`, `workflows/step-runner-account.test.ts`) stay in
   Results as the record of what was seen then, but they grant no allowance: any gate red **now**
   blocks, whatever its provenance.
9. **Deployed bytes** (Phase 4, §10a). Precondition, asserted first, because the step is
   meaningless without it: `GET http://127.0.0.1:4321/api/v1/ready` returns a `deploy.sha`, and
   `git merge-base --is-ancestor $(git rev-parse HEAD) <that sha>` exits `0`. Measured 2026-08-29:
   live `95b93175`, HEAD `ebdedb6c`, exit `0`. Also assert
   `/opt/cezar/packages/cezar/dist/workspace/todo-ordering.js` exists and that `fbsort` and
   `fasort` each appear in exactly one asset under `/opt/cezar/packages/cezar/web/dist/assets/`.
   **Do not grep the bundle for `filed-backlog-table` or `filed-active-section`**: measured
   2026-08-29, zero of 203 assets contain either, because both are assembled at runtime, and a
   grep that returns nothing would be read as a missing feature. Then run D6's exact command and
   assert `filed-partitions-deployed-requests.json` exists with `deployed: true`,
   `serverCli = /opt/cezar/packages/cezar/dist/index.js`, and `phases` counts of `2 / 1 / 1 / 1 /
   1`. Confirm the scratch tree is gone (the `trap` fired) and no instance survives, with `ls` and
   `pgrep`. Nothing is deployed or activated by this step.
10. **Production** (§10b): the owner's authenticated pass on `https://cockpit.example.com`. **Not
    an agent step** (`AGENTS.md:614-622`). Until it has run, the task is **QA Needed**.
11. **Record** (Phase 6), checked per destination because the doctrine differs per destination:
    - **In tree:** design spec §9/§10 and its status line amended in place; CHANGELOG entry;
      `.env.example` carrying `CEZ_E2E_SERVER_CLI` and `CEZ_ANALYTICS`; the README environment
      table carrying `CEZ_ANALYTICS`. Verified by `grep -n` on each of the four files.
    - **Corpus:** the status and changelog documents written under
      `/var/lib/cezar/loki-labs/notion-export/` **as `cezar`**, then reindexed, then **found by the
      search agents actually use**:

      ```sh
      cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb reindex
      cez kb search "active backlog tables browser e2e"     # must return the task document
      cez kb search "filed board active backlog changelog"  # must return the changelog entry
      ```

      Both documents must be discoverable through `cez kb search`, because that is the read path
      every session uses and *"a corpus write is not a KB write until you reindex"*. A
      `grep -ac '<doc-slug>' /var/lib/cezar/loki-labs/.ai/cezar/knowledge-index/catalog.ndjson`
      may be kept as supplemental diagnostics when a search misses, to tell "not indexed" apart
      from "indexed but not matched", but it is **not** the proof and does not substitute for the
      searches above.
    - **Knowledge:** `CEZ_KB_WRITE_FILE` holds exactly two lines, `seq: 0` and `seq: 1`, both
      `upsert`s for `knowledge/notes/filed-board-active-backlog-split-and-server-ordering.md`, the
      second opening with a bolded `CORRECTED 2026-08-29` lead-in. Verified with `node -e` reading
      the file and printing each line's `seq` and `path`. **Reported as pending application, not as
      landed:** `cez kb search` will not find it until a human applies the proposal, and saying
      otherwise would be the same "a corpus write is not a KB write" failure in a different
      costume.
    - **Tracker: CORRECTED 2026-08-29 (document step) — not hand-flipped to `in-progress`.**
      `todos.json` has no CLI to transition an existing row's status (only `add`, `start`,
      `list`); hand-editing the live file the running cezar server also owns risks a lost update
      against a concurrent write, so this step follows this same run's own precedent
      (`2095597b`, `eb854e91`: leave the originating row alone, file a fresh todo for what
      remains) instead. The originating row `1da9c2bb-fec2-43b9-9f91-4f13eb32fcc4` is left as
      filed; the remaining work (§10a, §10b) is tracked as new todo
      `7e35a93d-18ec-4afc-a5b3-eaaac14a1a0b`, referencing this spec.
12. **Ownership**: `find /var/lib/cezar -not -user cezar | wc -l` = `0` at the end of the session.

## Results

**Phase 1-3, local: PASS.** Filled in by the document step (2026-08-29) reading the artifacts
Phase 3 actually left on disk, not re-run here.

- Launch probe (Verification 1-2): the candidate loop in `.ai/scripts/test-env-up.sh:288-446`
  is present and is the code path that produced the descriptor `.ai/qa/test-env.json` this run
  consumed.
- Gate (Verification 4): `.ai/qa/artifacts_e2e/filed-partitions-verdict.json` (mtime
  2026-08-29T15:44:29Z) shows `initial: {active: 20, backlog: 30}`; `activeExpansion` and
  `backlogExpansion` both carry `appendedOnly: true` and `backlogUnchanged`/`activeUnchanged:
  true`; every row id matches the `fixture:<id>` shape the composite key check expects.
  `analytics.partitionViewed = ["active", "backlog"]`, `analytics.sorted` carries one entry per
  partition (`priority asc` on Active, `task asc` on Backlog), `analytics.showMore` carries
  exactly the two expected objects. `requests[].count` reads `2, 1, 1, 1, 1` for
  `load, sort-active, sort-backlog, expand-active, expand-backlog`, each URL carrying the
  expected `partition` and, for the sort/expand phases, the expected `fasort`/`fbsort` key. The
  five PNGs (`both-sections`, `active-sorted-priority`, `backlog-sorted-task`,
  `active-expanded`, `backlog-expanded`) are present and non-empty.
- Gates green (Verification 8): re-confirmed on the merged `54ff9bc1` tree by the commit-push
  step (2026-08-29T15:55Z): `npm run typecheck` exit 0, `npm test` 12142 passed / 4 skipped / 0
  failed.
- No leaked browser (Verification 7): not independently re-checked by this document step;
  `pgrep -fc 'chrome|chromium'` on this box currently reports 1 live process, of unknown
  origin (not attributed to this task's run, which closed its session before this step started).
  Carried forward as an open question rather than asserted either way.

**Phase 4 / §10a, deployed bytes: NOT RUN.** `.ai/qa/artifacts_e2e/filed-partitions-deployed-requests.json`
reads `"deployed": false`, `"liveSha": null`, `"serverCli"` pointing at this worktree's own
`packages/cezar/dist/index.js` rather than `/opt/cezar/packages/cezar/dist/index.js`. No assertion
in Verification item 9 has been checked against the live bundle.

**§10b, production: NOT RUN.** Not an agent step; the owner has not yet made the pass.

**Verdict: QA Needed, not Done.** Ten of the design spec's eleven acceptance clauses are met by
landed, gated tests plus the Phase 3 artifacts above. The eleventh — the deployed/production half
of "browser E2E artifacts prove both sections" — is unmet. Tracked as todo
`7e35a93d-18ec-4afc-a5b3-eaaac14a1a0b`.

## What could not be confirmed

- **Whether Playwright's Chromium launches on this box.** Not attempted. The sandbox abort is a
  kernel/AppArmor property, so it very likely needs `chromiumSandbox: false` too, but "very likely"
  is not a measurement and D4 says so at the point of use. Phase 5 measures it or Phase 5 does not
  happen.
- **Whether the other 18 e2e specs pass here.** Nobody has ever run them on this box, so the size
  of Phase 3's fix list is genuinely unknown. D5 bounds the correctness risk, not the effort; if
  the list is large, that is a schedule conversation with the owner, not grounds to reclassify
  failures.
- **Whether the `TMPDIR` limit is exactly 108 bytes here.** The failure mode is measured and
  reproducible, and the fix (a short scratch dir) is measured to work. The precise `sun_path` cap
  is taken from the Linux ABI and was not probed by bisecting path lengths, so the "90 bytes of
  headroom" figure in D2 is arithmetic, not an experiment.
- **The cost of the daemon reuse behaviour across a full suite run.** Every measured `open`
  reported `reused: true`, which is good for wall-clock and is exactly why Risk 2 exists. Whether
  19 specs sharing one daemon interfere with each other is unknown until Verification 6 runs.
- **`214b32df`'s current state beyond its status field.** Read as `todo` from
  `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json` (206 rows) on 2026-08-29. Whether Phase 1
  alone actually unblocks it is a claim about its own failure mode, which was not re-run here.

## Open items carried forward, not settled here

- **The tombstone leak on the legacy `GET /workspace/todos` path**, carried unchanged from the
  design spec. Still needs its own decision about whether a `BACKWARD_COMPATIBILITY.md`
  §2-protected response may stop carrying deleted rows.
- **`queryZodValidator` publishes the schema OUTPUT as the route's request type**: real, affects
  about 15 routes, documented in the design spec's Implementation note 2 and in `api/client.ts`.
  Its own spec, not this one.
- **The queued KB proposal from the prior session** (one `upsert`, `seq: 0`, in
  `CEZ_KB_WRITE_FILE`) is still unapplied, is not searchable, and is stale in three named ways: see
  Phase 6 item 3, which appends the `seq: 1` correction rather than leaving it to be discovered.
  Application remains a human step through the cockpit or `cez kb proposals`; this spec cannot
  close it and does not claim to.
- **`.ai/browsers/agent-browser.md` documents the old ensure-installed contract**, including its
  own `printf 'BROWSER_PROVIDER=agent-browser…'` at `:77`. It is a descriptor document, not code,
  and D2/D3 change what the script does rather than what the provider is. It should be updated to
  describe the candidate-condition probe when Phase 1 lands, and that edit is in Phase 1's scope,
  but the wider question of whether descriptor documents should be generated from the script rather
  than maintained beside it is not settled here.
