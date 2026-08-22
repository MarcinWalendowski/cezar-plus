# Document the headless browser on `prod-host` in `AGENTS.md`

> **Status:** **implemented** 2026-08-22 — the `## Headless browser on prod-host` section
> is in `AGENTS.md`, both documented invocations were executed on the box, and the Cloudflare
> fallback was proven live. · **Date:** 2026-08-22
>
> **Brief:** `.ai/specs/briefs/2026-08-22-headless-browser-playwright-agents-md.md`, written by
> step 1 ("context") of this run. This spec follows its citations and re-verifies the box state
> itself (§ below) rather than copying the brief's numbers, because the brief flagged its own
> size/engine-count discrepancy against the task handoff as unresolved (open question 5).
>
> **Task:** run `06a8d677-bf84-45f2-9927-1e50032e219b`, "Document the headless browser now
> installed on prod-host in AGENTS.md — agents can drive real pages, with CF Browser
> Rendering as the fallback."
>
> **Revised 2026-08-22 after review** (`.ai/specs/2026-08-22-headless-browser-on-prod-host.md`
> review pass): moved from a stray untracked file in the main checkout into this worktree so it
> lands in the same commit as the `AGENTS.md` edit; rewrote the trap paragraph, which previously
> told the reader `CEZ_ENV_PASSTHROUGH` "will fail with no error" for `PLAYWRIGHT_BROWSERS_PATH`
> while the same section's own § Problem trace shows a passthrough entry is admitted
> unconditionally — the true failure mode is that the variable is dropped only when it is set on
> the host *alone*, exactly as the Cloudflare paragraph two sentences later already states for the
> case where it *is* wired through; fixed the outer/inner code-fence nesting; added a Phase 3 KB
> write; and folded in the reviewer's cheap nits (drop the unmeasured `486ms` figure, add a
> `browser.close()` hygiene line, note the cache is `$HOME`-scoped so a non-interactive root shell
> won't see it).

## TLDR

Playwright 1.62.1 + Chrome for Testing (plus Firefox and WebKit — more than the task handoff
described) were installed on `prod-host` on 2026-08-21 and manually verified working, but no
spec, KB entry or `AGENTS.md` section records it, so no agent will ever reach for it. This is a
**doc-only** change: add a new top-level `AGENTS.md` section, placed directly after the existing
`## Validation` section (after its `agent-browser`/`test:e2e` paragraph, before `## How an agent
step should spend its tool calls`), that tells an agent step: (1) the browser exists on this box
and two exact invocations that work, (2) the one trap that will silently break it if "fixed" —
`PLAYWRIGHT_` is not in the agent-env allowlist, so the install must stay at Playwright's default
cache path — and (3) Cloudflare Browser Rendering as the documented fallback, whose credentials
are **already** flowing to agents today (not a TODO, contra the task handoff's framing). The
`implement` step proves the doc by using the browser for one real navigation as part of its own
work, which lands in this run's own NDJSON — no new test file, no persisted script, nothing to
maintain going forward.

## Problem

### Nothing documents a capability that already exists

`playwright --version` on this box returns `Version 1.62.1` (binary at `/usr/bin/playwright`,
confirmed this session). `AGENTS.md` has no section naming Playwright, raw browser access, or
this box's specific tooling at all — confirmed by `grep -n '^#' AGENTS.md`, whose 10 headings
(`Shipping cezar itself`, `Zero config`, `Changing a mechanism that already works`, `The HTTP
API`, `Repository layout`, `Task routing`, `Validation`, `How an agent step should spend its tool
calls`, `Related documents`, plus the `### Four environment traps` / `### Debugging an
intermittent failure` subsections under Validation) contain nothing about a raw browser, only the
`agent-browser` CLI contract (`AGENTS.md:395-413`) scoped to the `test:e2e` smoke suite. An agent
working any other task — "scrape a page a spec cites," "check a deployed URL renders," "read docs
that need JS" — has no reason to know Playwright is sitting one `require()` away.

### The box's actual state doesn't match the task handoff, and the mismatch matters for what gets written

Re-verified live on `prod-host` this session (not copied from the handoff or the brief):

```
$ du -sh "$HOME/.cache/ms-playwright"; ls "$HOME/.cache/ms-playwright"
1.2G
chromium-1234  chromium_headless_shell-1234  ffmpeg-1011  firefox-1538  webkit-2336
```

The task handoff says "Chrome for Testing + chrome-headless-shell + ffmpeg ... 656MB"
(Chromium-family only). The box today carries **five** directories — Chromium, its
headless-shell variant, ffmpeg, **and also Firefox and WebKit** — at roughly double the
described size. Either a broader `playwright install` (no engine argument) ran after the
2026-08-21 verification, or the original install was under-described; nothing in the repo, KB,
or git history records which (checked `git log --all`, KB search, `cezar todo list` — brief §
"What I could NOT find" already ruled this out, re-confirmed here). The only thing actually
*exercised* against a live URL (per the handoff's own verification narrative) was Chromium
against `https://example.com` and `https://cockpit.example.com`. **The doc should name what
exists (all three engines, so a reader isn't surprised by `du`) but scope its "verified working"
claim to Chromium**, since that is the only engine anyone has actually driven.

### The env allowlist will silently break this if anyone "cleans it up" — but the failure mode has one nuance that matters

`packages/cezar/src/core/agent-env.ts` gives every spawned agent backend an **allowlisted** child
environment via `buildChildEnv()` → the inner `allow(name)` gate (lines 363-392). Confirmed by
direct read this session:

- `BASE_ALLOW_NAMES` (`upperSet([...])`, starting line 36) is an explicit list of exact names —
  `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `LNAME`, `PWD`, `OLDPWD`, `SHLVL`, `TERM`, … — **no**
  `PLAYWRIGHT_BROWSERS_PATH` and no `CLOUDFLARE_*` name.
- `BASE_ALLOW_PREFIXES` (starting line 134) is an explicit list of prefix families — `LC_`,
  `XDG_`, `LESS_`, `NODE_`, `NPM_CONFIG_`, `NVM_`, `PNPM_`, `YARN_`, `BUN_`, `DENO_`, … — **no**
  `PLAYWRIGHT_` and no `CLOUDFLARE_` prefix. Confirmed by `grep -n "PLAYWRIGHT\|CLOUDFLARE"
  packages/cezar/src/core/agent-env.ts` returning zero matches in the whole 393-line file.
- `allow()` (lines 364-392) admits a name only via, in order: the `CEZ_` namespace when
  non-secret-shaped (line 375), `GH_ALLOW_NAMES` (376), a backend-specific prefix (377), a
  cloud-provider name/prefix when that toggle is on (378), an explicit `CEZ_ENV_PASSTHROUGH`
  entry (line 385, `if (passthrough.has(key)) return true` — no `looksSecret` guard on this path,
  unlike the two below it), or the two base lists above (lines 390-391). `PLAYWRIGHT_*` and
  `CLOUDFLARE_*` match none of these **by default**.
- `HOME` and `PATH` **are** in `BASE_ALLOW_NAMES` (confirmed at the top of the list).

**The failure mode is conditional, and the doc has to say which condition it is warning about.**
`allow()`'s `CEZ_ENV_PASSTHROUGH` branch (line 385) is not gated by `looksSecret` — it admits
*any* name listed there, unconditionally. That is exactly the mechanism the § below shows already
carrying `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` to every agent today. So it is **not true**
that a `PLAYWRIGHT_*` name is dropped no matter what is done — it would reach an agent just fine if
someone named it in `CEZ_ENV_PASSTHROUGH`, the same two-step the Cloudflare credentials went
through. What actually happens, and what is silent, is narrower: if `PLAYWRIGHT_BROWSERS_PATH` is
set on the host (a systemd unit env, a shell profile) and **nothing else is done**, it is dropped
before any agent's child process starts — Playwright falls back to its own compiled-in default
path, finds no browsers there, and every launch fails with nothing in the agent's own environment
pointing at the cause. Making a moved install work *would* be possible via the passthrough route;
skipping the second step (naming it in `CEZ_ENV_PASSTHROUGH`) is what fails silently, not
passthrough itself. Playwright's own default browser cache path is `$HOME/.cache/ms-playwright`,
and `$HOME` is already allowlisted — which is why the install works today with zero env
configuration and needs neither step. The same reasoning applies to `require('playwright')`
resolving from any cwd: it works via `$HOME/.node_modules/{playwright,playwright-core}` symlinks
to `/usr/lib/node_modules/{playwright,playwright-core}` (confirmed via `ls -la`), which rides on
Node's own global-folder lookup (`node -e "require('module').globalPaths"` → includes
`/var/lib/cezar/.node_modules`, confirmed this session) rather than `NODE_PATH`.
**Corrected 2026-08-22 during review:** an earlier draft said `NODE_PATH` "would need the same
passthrough treatment," which is false — `NODE_` **is** in `BASE_ALLOW_PREFIXES` (`agent-env.ts:138`)
and `looksSecret('NODE_PATH')` is `false` against `SECRET_NAME_RE` (`secret-redaction.ts:29`,
evaluated directly), so a host-set `NODE_PATH` forwards to every agent with no passthrough entry.
The symlink is preferred for a different reason: it is a knob where a working default exists
(§ Zero config), not because the allowlist would drop it.

This is not a hypothetical: `AGENTS.md`'s own "Zero config" section (lines 15-28) already states
the rule this install follows ("when a feature seems to need configuration, the design is
wrong," "never trade a working default for a knob") and "Changing a mechanism that already works"
(lines 30+) is the section built entirely around examples of a well-intentioned change quietly
removing a load-bearing default. Nothing currently on record connects that doctrine to this
specific install, so a future session has no way to know that adding
`PLAYWRIGHT_BROWSERS_PATH` — which looks like a reasonable tidy-up — is exactly the mistake those
sections warn against, or that "just add it to `CEZ_ENV_PASSTHROUGH` too" is a two-step fix easy
to half-do.

### Cloudflare Browser Rendering credentials are already flowing — the handoff's framing is stale

The task handoff frames the fallback as needing setup: *"CLOUDFLARE_ is not in the agent env
allowlist either, so that route needs CEZ_ENV_PASSTHROUGH or a wrapper."* Read live on this box
this session:

```
$ grep -o 'CEZ_ENV_PASSTHROUGH=[^ ]*' /etc/cezar/agent-env.env
CEZ_ENV_PASSTHROUGH=OP_SERVICE_ACCOUNT_TOKEN,CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID
```

`/etc/cezar/agent-env.env` (0644 root:root) already lists both `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in `CEZ_ENV_PASSTHROUGH`, dated 2026-08-19 per `AGENTS.md`'s own 1Password
section and corroborated by the brief's KB citations (`notion-fef17e60fa1b`,
`notion-b54dec63af6e`). Per the `allow()` trace above, an entry in `CEZ_ENV_PASSTHROUGH` bypasses
`looksSecret` and is admitted unconditionally — so both variables are **already** reaching every
agent's child environment on this box today, not pending any change. `/etc/cezar/cloudflare.env`
also exists (0640 root:cezar, 413 bytes; contents not read — out of scope, and unnecessary to
read for this doc). Writing the handoff's "needs a wrapper" framing into `AGENTS.md` verbatim
would put a stale caveat into a document whose whole job is to be the current record — the
opposite of the global CLAUDE.md's "read what already exists first." This is also the paragraph
that makes the trap section's nuance (above) non-optional: without it, a reader would have no way
to tell why `CLOUDFLARE_*` "already reaches every agent" while `PLAYWRIGHT_*` "would be dropped" —
the answer is that one has actually been named in `CEZ_ENV_PASSTHROUGH` and the other has not, not
that passthrough works for one prefix and not the other.

### A second, existing browser mechanism must be reconciled, not duplicated

`AGENTS.md:395-413` already documents `agent-browser` (full contract in
`.ai/browsers/agent-browser.md`): a self-provisioning, cross-platform (macOS/Linux/Windows,
glibc/musl) native binary that downloads itself into `$XDG_CACHE_HOME/agent-tools/agent-browser`
with **no env-var trap at all**, exposing a fixed operation contract (`ensure-installed`,
`doctor`, `open`, `snapshot`, `interact`, `assert`, `screenshot`, `close`) built against a
`browser-provider` contract referenced as `TEMPLATE.md` (that file does not exist in this repo —
confirmed via `find . -iname TEMPLATE.md`; likely upstream/private to the `agent-browser`
project, not something this spec can cite further). It's introduced in `AGENTS.md` as the driver
for `npm run test:e2e`, but its snapshot/interact/screenshot operations are generic, not
e2e-suite-specific. Without an explicit sentence positioning the two, a reader hits a second "how
to drive a browser" a hundred lines later and has to guess whether it's a competing mechanism, a
replacement, or something else entirely.

The two are **not competing**: `agent-browser` is a fixed CLI contract, portable to any dev
machine (including one with no Playwright install at all), good for driving/inspecting a UI via
its snapshot/interact verbs. Raw Playwright is Node-API-level — `page.evaluate()`, arbitrary
scripting inside a larger program, a one-line `playwright screenshot` CLI — and, as installed, is
**specific to `prod-host`**: nothing establishes that any other machine running cezar has
Playwright's browsers cached (each dev machine or CI runner would need its own `playwright
install`, unlike `agent-browser`'s self-provisioning download). The acceptance criteria for this
task ask specifically for `require('playwright')` and `playwright screenshot <url> <file>` — both
below `agent-browser`'s contract layer — which is exactly the raw-Node-API / zero-code-CLI case
`agent-browser` doesn't cover.

## Solution

Add one new top-level `AGENTS.md` section, `## Headless browser on prod-host`, inserted
immediately after the `## Validation` section's closing line (currently line 413, the
`CEZ_DRY_RUN=1 npm run dev` sentence) and before `## How an agent step should spend its tool
calls` (currently line 415). This is the same neighborhood as the `agent-browser` paragraph
(`AGENTS.md:395-413`), so a reader who just read about `agent-browser` sees the reconciling
sentence immediately, without the two being merged into one section (they answer different
questions: "how does the e2e suite drive a browser" vs. "what raw browser access does this
specific box have"). No bullet is added to `## Related documents` (`AGENTS.md:528`): that list
indexes separate Markdown files (`AGENT_PROTOCOL.md`, `SDLC.md`, …), not internal `AGENTS.md`
sections, and the new section is discoverable the same way `agent-browser` already is — by
scanning `AGENTS.md`'s own heading list.

### Exact content (verbatim, to land as written)

> **Superseded 2026-08-22 by what actually landed in `AGENTS.md`.** The block below is the
> pre-implementation draft, kept unchanged for the record; read `AGENTS.md` § "Headless browser
> on prod-host" for the current text. Three corrections were made during implementation,
> each verified on the box rather than reasoned about:
>
> 1. **The `NODE_PATH` clause was wrong** and is gone — see the correction in § Problem above.
>    The shipped section says plainly that `NODE_PATH` *would* survive the allowlist and that the
>    symlink is preferred on § Zero config grounds instead.
> 2. **CommonJS-only resolution was missing.** This repo is `"type": "module"` and Node's
>    global-folder lookup does not apply to ESM, so `import { chromium } from 'playwright'` in a
>    `.mjs`/repo `.js` fails with `ERR_MODULE_NOT_FOUND` (reproduced). The shipped section warns
>    about this and gives a `createRequire(import.meta.url)` escape hatch, executed and passing.
> 3. **The Cloudflare fallback was rewritten against the live product**, read with this very
>    browser: it is now **Browser Run** (renamed from Browser Rendering; the old name survives in
>    the API path). The Puppeteer/Playwright-compatible route from a box like this one is
>    **CDP over WebSocket** (`/devtools/browser` + `chromium.connectOverCDP()`), *not*
>    `@cloudflare/playwright`, which is a Workers-only fork needing a `browser` binding. The REST
>    "Quick Actions" endpoints are the other shape and are not a Playwright API. A live
>    `POST .../browser-rendering/content` with the box's existing credentials returned **200 with
>    rendered HTML**, so the fallback needs no new token — while
>    `GET /user/tokens/verify` returns **401** for that same token, which is why the section ends
>    by repeating SPEC-403's "probe the capability, never the token's identity papers."

The block below uses a 4-backtick outer fence specifically so the two 3-backtick code fences
inside it nest correctly under CommonMark (a 3-backtick fence cannot safely contain another
3-backtick fence — the first bare `` ``` `` inside would close the *outer* block early and leave
the rest of the document unintentionally inside an unclosed fence). Copy the content between the
outer ```` ````markdown ```` and matching ```` ```` ```` lines, excluding those two lines
themselves.

````markdown
## Headless browser on prod-host

`prod-host` has a real, verified-working headless browser — Playwright 1.62.1 with Chrome
for Testing (plus Firefox and WebKit; only Chromium has actually been driven against a live URL).
Installed and manually verified 2026-08-21: external navigation to `https://example.com` returned
200 with the correct title/h1, a screenshot was written, injected JS executed, and the same worked
against `https://cockpit.example.com` under an environment stripped to exactly what
`buildChildEnv()` forwards to an agent (`PATH`/`HOME`/`USER`/`LOGNAME`/`SHELL`/`LANG`/`TERM`/`PWD`,
nothing else). An agent step MAY reach for it directly for any task that needs a real rendered
page — checking a deployed URL actually renders, scraping a page a spec cites, reading JS-rendered
docs — without asking first. The cache is scoped to `$HOME` (`/var/lib/cezar/.cache`), so a
non-interactive `ssh root@prod-host '<cmd>'` shell — whose `$HOME` is `/root`, not this
box's own agent user — finds no browsers there; an interactive session or an agent run (both of
which see the right `$HOME`) does.

Two invocations both work, verbatim, from any cwd:

```bash
node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://example.com');
  console.log(await page.title());
  await browser.close();
})();
"

playwright screenshot https://example.com /tmp/example.png
```

Always call `browser.close()` when scripting against Playwright directly — a zombie Chrome
process left behind under a concurrent run is the same failure mode named as the fallback's
trigger, below.

**This is separate from `agent-browser`** (§ Validation, above): `agent-browser` is a portable,
self-provisioning CLI contract (`snapshot`/`interact`/`assert`/`screenshot`) that works on any dev
machine cezar runs on, including one with no Playwright install. Raw Playwright, as installed
here, is specific to this box — reach for it when the job needs Node-API-level control
(`page.evaluate()`, scripting inside a larger program) or the zero-code `playwright screenshot`
one-liner; reach for `agent-browser` when driving/inspecting a UI through its fixed verb set on a
machine that may not be this one.

**The one trap that will silently break this: never set `PLAYWRIGHT_BROWSERS_PATH` on the host
alone.** `packages/cezar/src/core/agent-env.ts`'s `buildChildEnv()` gives every agent an
*allowlisted* environment — `BASE_ALLOW_NAMES`/`BASE_ALLOW_PREFIXES` contain `HOME` and `PATH` but
no `PLAYWRIGHT_` name or prefix. So if `PLAYWRIGHT_BROWSERS_PATH` is exported on the host (a
systemd unit, a shell profile) and nothing else is done, it is dropped before any agent's child
process starts: Playwright falls back to its own compiled-in default path, finds no browsers
there, and every launch fails with nothing in the agent's own environment pointing at the cause.
That is *why* the browsers were deliberately installed at Playwright's own default
`$HOME/.cache/ms-playwright` (currently 1.2G) rather than somewhere "tidier" — it needs zero env
configuration, because `HOME` is already allowlisted. The same reasoning is why bare
`require('playwright')` resolves from any cwd via `$HOME/.node_modules` symlinks (Node's own
global-folder lookup) rather than via `NODE_PATH`. Making a moved install work *would* be
possible — it needs the same two-step the Cloudflare credentials below went through: set the
variable in the service env **and** name it in `CEZ_ENV_PASSTHROUGH` in
`/etc/cezar/agent-env.env`. But skipping the second step fails exactly as silently as skipping
both, so **don't take that path**: leave the browsers at the default `$HOME/.cache/ms-playwright`,
which needs neither step, per § Zero config's "never trade a working default for a knob."

**Fallback: Cloudflare Browser Rendering**, if local headless proves unreliable under concurrent
agent runs (memory pressure, zombie Chrome processes, bot detection on the target site). It speaks
a Puppeteer/Playwright-compatible API, so calling code changes minimally. Credentials are
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in `/etc/cezar/cloudflare.env` (0640
root:cezar) — and, like `PLAYWRIGHT_`, the `CLOUDFLARE_` prefix is not in the agent-env allowlist
either. Unlike Playwright, this fallback needs no new wiring: both names are **already** listed in
`CEZ_ENV_PASSTHROUGH` in `/etc/cezar/agent-env.env` (since 2026-08-19), so they already reach
every agent's child environment today.
````

### Why this placement, and why a top-level `##` rather than a `###` under Validation

`agent-browser` lives inside `## Validation` because its only documented job there is driving
`npm run test:e2e`. This capability is not test-specific — the acceptance criteria name
non-test uses ("scraping a page a spec cites," "checking a deployed URL renders") — so folding it
into `## Validation` would misstate its scope. A new top-level section keeps `## Validation`
about gates and gives this capability equal billing with `## Repository layout` or `## Task
routing`, which is the level a reader scanning `AGENTS.md`'s heading list (§ Problem, above)
would expect to find "what tools does an agent have" at.

## Architecture

No code changes. This is a documentation-only spec: one new `##` section in `AGENTS.md`, ~45
lines, citing existing, unmodified files; plus one KB proposal line (Phase 3, below):

```
AGENTS.md                                    ← edited (new section)
packages/cezar/src/core/agent-env.ts         ← cited, read-only
.ai/browsers/agent-browser.md                ← cited, read-only
/etc/cezar/agent-env.env                     ← cited by path, read-only (host state)
/etc/cezar/cloudflare.env                    ← cited by path, read-only (host state, secrets)
$HOME/.cache/ms-playwright                   ← cited by path, unmodified (existing install)
$CEZ_KB_WRITE_FILE                           ← appended (one NDJSON upsert proposal, Phase 3)
```

No new `CEZ_*` environment variable is introduced, so `.env.example` (per `AGENTS.md:28`, "Adding,
renaming, or removing a `CEZ_*` env var ... MUST update `.env.example` in the same commit") is
**not** touched — that rule does not apply here, and this is the point, not an oversight: the
whole design this doc describes exists specifically so no env var is needed.

## Data models / API contracts

Not applicable — no schema, route, or stored data changes. The two "contracts" this spec
documents are both external and already fixed: Playwright's own Node API (`require('playwright')`
→ `chromium.launch()` / `page.goto()` / `page.title()` / `browser.close()`) and its `playwright
screenshot <url> <file>` CLI, neither owned by this repo.

## Phases

### Phase 1 — Write the `AGENTS.md` section

Insert the exact Markdown block from § Solution into `AGENTS.md` between the current lines 413
and 415 (the boundary may drift by the time `implement` runs if an unrelated edit lands first —
locate it by content: after the `CEZ_DRY_RUN=1 npm run dev` sentence, before `## How an agent step
should spend its tool calls`). No other file changes. Independently shippable and independently
useful: this alone satisfies acceptance criteria 1-3.

### Phase 2 — Prove it by use, in the same run

As part of this task's own `implement` step (not a separate persisted script — see rationale
below), perform one real Playwright navigation against a live URL — `https://cockpit.example.com`
is the natural choice, since it's this task's own deployment target and was already used in the
2026-08-21 verification. Confirm the navigation succeeds (title or status code) and that this
step's own NDJSON records the tool call that ran it. This satisfies acceptance criterion 4
("a real run uses the browser for an actual task and its NDJSON shows a successful navigation")
directly, since every step of this task's run is itself recorded to NDJSON — no additional
harness is needed to produce that evidence.

**Why not a persisted `.ai/scripts/*.smoke.mjs`:** the brief's open question 4 raised this as a
choice. A persisted script is justified when something needs to be *re-run* later (e.g. a CI
smoke gate); nothing in the acceptance criteria asks for repeatability, only that a real
navigation happen and show up in this run's own record. Adding a script nobody re-runs is exactly
the "abstraction beyond what the task requires" the global CLAUDE.md instructs against — the
`implement` step's own tool call is real use, and real use is what the criterion asks for.

### Phase 3 — Record the capability in the KB corpus

Append one `upsert` proposal to `CEZ_KB_WRITE_FILE`, scope `project`, recording that
`prod-host` has Playwright (Chromium/Firefox/WebKit) installed at the default
`$HOME/.cache/ms-playwright` cache path, and that `PLAYWRIGHT_`/`CLOUDFLARE_` are not in
`agent-env.ts`'s allowlist by default (reaching an agent only via `CEZ_ENV_PASSTHROUGH`, which is
how the Cloudflare credentials already do). This follows the shape of the two 2026-08-19
credential-resolution KB entries (`notion-7203ce1238f8`, `notion-fef17e60fa1b`) that record this
same class of fact — a box-level capability that lives only in `cezar/AGENTS.md` is invisible to
an agent working a task in a different repo (e.g. `chat/`), which reads its own `CLAUDE.md` and KB
and has no reason to open this repo's `AGENTS.md`. Independently shippable after Phase 1; not
required for acceptance criteria 1-4 (which name `AGENTS.md` specifically) but required by this
repo's own record-keeping rule (global CLAUDE.md § "keep the record straight" — "when a durable
decision or architecture choice emerges, write it down where the next session will read it, not
only in the commit message").

## Risks

- **Section drift**: if another change lands in `AGENTS.md` between this spec and `implement`,
  the exact line numbers cited above will have moved. Mitigated by anchoring the insertion point
  to content (the `agent-browser` paragraph boundary), not line numbers.
- **Engine-count precision**: the doc states "Chromium for Testing (plus Firefox and WebKit; only
  Chromium has actually been driven)" rather than a byte-exact size, because `du -sh` will drift
  as the cache is touched — stating an exact MB figure in a doc meant to stay accurate risks going
  stale the next time someone runs `playwright install` with a different engine set. If a future
  session needs an exact figure it can re-run `du -sh "$HOME/.cache/ms-playwright"` itself. For
  the same reason the doc does not repeat the handoff's unverified `486ms` navigation timing —
  this run measured only that the navigation succeeds, not how fast, and a specific millisecond
  figure nobody in this run measured would read as re-verified when it wasn't.
- **This is a single-box fact, not a repo-wide guarantee.** The new section is explicit that this
  is `prod-host`'s own install; nothing in this change claims any other machine (a
  developer's laptop, a CI runner) has Playwright's browsers cached. A reader on a different box
  who tries the `require('playwright')` one-liner and finds no browsers installed is not
  encountering a doc error — the section says as much by scoping itself to this box in its
  heading.
- **`CLOUDFLARE_` credential exposure surface.** Documenting that `CLOUDFLARE_API_TOKEN`/
  `CLOUDFLARE_ACCOUNT_ID` already reach every agent's child environment (via
  `CEZ_ENV_PASSTHROUGH`) is stating an existing fact, not introducing a new exposure — but writing
  it down in `AGENTS.md` makes it more discoverable, including to any agent task that might
  otherwise not have thought to look. This is judged acceptable because the token/account id were
  already deliberately passed through by a 2026-08-19 owner decision (per `AGENTS.md`'s own
  1Password section) — this spec documents an existing, intentional grant, it does not create one.
- **The trap paragraph is the one place a small wording error is worst.** Its previous draft
  stated a blanket "passthrough will fail" claim that the § Problem trace itself contradicts; the
  revised wording (this version) narrows the claim to "set on the host alone, with no passthrough
  entry" and explicitly says the passthrough route *would* work if completed. A future edit to
  this section should preserve that distinction rather than re-simplifying it back to a blanket
  claim, since the blanket version is the one that reads as internally inconsistent next to the
  Cloudflare paragraph.

## Verification

This is a doc-only change; there is no typecheck/lint/test gate that exercises Markdown content.
Verification is: (1) the section exists and is accurate against the live box, (2) a real
navigation happened and is recorded, and (3) the KB proposal was appended.

1. **Content check** — after `implement`, `grep -n "Headless browser on prod-host"
   AGENTS.md` finds the new heading, positioned after the `## Validation` section's
   `agent-browser` paragraph and before `## How an agent step should spend its tool calls`.
2. **Both verbatim invocations actually run**, on this box, in the `implement` step (not merely
   pasted into the doc unverified):
   ```bash
   node -e "
   const { chromium } = require('playwright');
   (async () => {
     const browser = await chromium.launch();
     const page = await browser.newPage();
     await page.goto('https://example.com');
     console.log(await page.title());
     await browser.close();
   })();
   "
   playwright screenshot https://example.com /tmp/example-verify.png
   ```
   Expected: the `node -e` command prints `Example Domain` (the actual page title) and exits 0;
   `playwright screenshot` exits 0 and `/tmp/example-verify.png` exists with nonzero size
   (`test -s /tmp/example-verify.png`).
3. **The env-allowlist claim is re-checked, not just cited**: `grep -n "PLAYWRIGHT\|CLOUDFLARE"
   packages/cezar/src/core/agent-env.ts` returns zero matches, confirming the doc's central claim
   still holds against the code as it stands at `implement` time (not merely as it stood when this
   spec was written).
4. **Acceptance criterion 4, mechanically**: after `implement` runs the navigation in step 2 above
   as part of its own tool calls, `cez run stats <this-run-id> --json` (or the run's own NDJSON
   file under `.ai/cezar/runs/`) shows a completed tool call for that command in the `implement`
   step. This is the "proven by use" evidence the acceptance criteria ask for — it is produced by
   the run itself, not fabricated after the fact.
5. **The KB proposal landed**: `CEZ_KB_WRITE_FILE` (Phase 3) contains a new `upsert` line with a
   unique `seq` continuing this run's sequence, `runId` matching this run's id, and a body
   naming the `$HOME/.cache/ms-playwright` path and the `PLAYWRIGHT_`/`CLOUDFLARE_` allowlist gap.
6. **No regression to existing gates**: `npm run typecheck`, `npm test`, `npm run test:unit` still
   pass unchanged, since no `.ts`/`.tsx` file is touched by this spec's phases. (Not re-run in this
   step, which only writes the spec; `implement`/`run-tests` are responsible for actually
   executing these and reporting the result.)
