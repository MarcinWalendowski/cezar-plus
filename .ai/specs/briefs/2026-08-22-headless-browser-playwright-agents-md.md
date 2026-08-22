# Brief — Document the headless browser on prod-host in AGENTS.md

**Task id:** 06a8d677-bf84-45f2-9927-1e50032e219b · **Step:** 1/8 (Gather the record)

## Problem, in this repo's own terms

`prod-host` had Playwright 1.62.1 + Chrome for Testing installed and
manually verified on 2026-08-21 (per this task's own handoff context — no spec
or KB entry records the install itself; see "What I could not find"). Nothing
in `AGENTS.md` says this exists, so no agent working a task will ever reach
for it — it's an undocumented capability. The task is a **doc-only** change to
`AGENTS.md` (plus, per the global CLAUDE.md "spec driven" rule, arguably a
short spec), gated on a **real** browser navigation actually happening and
showing up in a run's NDJSON — "proven by use, not by being written" per this
task's own acceptance criteria.

This repo already has an *unrelated-but-adjacent* prior decision the new
section must not collide with: a self-provisioning, cross-platform browser
automation contract called `agent-browser` is already documented (see below).
The brief's main open question is how the new section should position itself
relative to that existing mechanism.

## What the record already decided (with citations)

**1. The agent env is an allowlist, and `PLAYWRIGHT_`/`CLOUDFLARE_` are not in it.**
`packages/cezar/src/core/agent-env.ts` — `buildChildEnv()`. `BASE_ALLOW_NAMES`
(lines 35-129, built via `upperSet([...])`) is an explicit list of ~50 names
(`PATH, HOME, SHELL, USER, LOGNAME, ... TERM, ...`) plus a Windows-only block;
`BASE_ALLOW_PREFIXES` (lines 134-199) is an explicit list of ~50 prefixes
(`LC_, XDG_, NODE_, NPM_CONFIG_, ... CARGO_, GOPATH, ... HOMEBREW_, ...`).
Neither list contains `PLAYWRIGHT_` or `CLOUDFLARE_`. The `allow()` gate
(lines 364-392) admits a name only via: `CEZ_` prefix (secret-filtered),
`GH_ALLOW_NAMES`, backend-specific prefixes, cloud-provider names when a
toggle is on, an explicit `CEZ_ENV_PASSTHROUGH` entry, or the two base lists
above — `PLAYWRIGHT_` and `CLOUDFLARE_` match none of these paths by default.
`HOME` and `PATH` **are** in `BASE_ALLOW_NAMES` (lines 37-38). This is also
recorded in the KB: `notion-7203ce1238f8` and `notion-260b16ae2cbe` ("Agents
get an allowlisted environment, so a credential must be named in
`CEZ_ENV_PASSTHROUGH` or it is invisible inside a run").

**2. `CEZ_ENV_PASSTHROUGH` is the documented bypass, and it already carries the
Cloudflare credentials on this box — verified live, not assumed.**
Read at `agent-env.ts:334` (`readVar(source, 'CEZ_ENV_PASSTHROUGH')`), split
into a `Set` (`:333-338`), consulted in `allow()` at line 385
(`if (passthrough.has(key)) return true`) — this bypasses the `looksSecret`
filter that guards the `CEZ_`/base-prefix paths (lines 376, 390 guard with
`!looksSecret(key)`; the passthrough path does not). **I read the actual file
on this box** (this session's Bash tool is running directly on
`prod-host` — confirmed via `hostname`): `/etc/cezar/agent-env.env`
(0644 root:root) currently sets
`CEZ_ENV_PASSTHROUGH=OP_SERVICE_ACCOUNT_TOKEN,CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID`.
**This contradicts the task handoff's framing** that CF Browser Rendering
"needs `CEZ_ENV_PASSTHROUGH` or a wrapper" as an open problem — it doesn't;
that passthrough entry already exists (dated 2026-08-19 per AGENTS.md and KB
`notion-fef17e60fa1b` / `notion-b54dec63af6e`), so `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` are **already reaching agents' child env today** on
this box. The doc should state this as a fact, not a caveat to resolve.
`/etc/cezar/cloudflare.env` itself also exists (0640 root:cezar, confirmed via
`ls`, contents not read).

**3. `agent-browser` — an existing, documented, general-purpose browser
contract this section must be positioned against.** `AGENTS.md:395-396` and
`.ai/browsers/agent-browser.md` (full spec, ops: `ensure-installed`, `doctor`,
`open`, `snapshot`, `interact`, `assert`, `screenshot`, `close`) already give
agents a self-provisioning, cross-platform (macOS/Linux/Windows) Chrome
automation tool with **no env-var trap at all** — it downloads its own binary
into `$XDG_CACHE_HOME/agent-tools/agent-browser` and needs nothing beyond
`HOME`/network. It's introduced in AGENTS.md as the driver for the UI e2e
smoke suite (`npm run test:e2e`, `AGENTS.md:395-413`), but its operation
contract (snapshot/interact/screenshot) is generic, not e2e-suite-specific.
**This is prior art the new section needs to reconcile with, not duplicate**:
is raw Playwright a second, competing way to "drive a page", or does it cover
a case `agent-browser`'s fixed CLI contract doesn't (raw Node API access,
custom `page.evaluate()` JS injection, scripting inside a larger Node
program)? The task's own acceptance criteria ask specifically for
`require('playwright')` and `playwright screenshot <url> <file>` — both
lower-level than `agent-browser`'s contract — so the two are likely
complementary, but the spec step should say so explicitly rather than let a
reader wonder why there are two.

**4. Zero-config doctrine already predicts the right design, and the install
already followed it.** `AGENTS.md:258-262` ("§ Zero config"): "when a feature
seems to need configuration, the design is wrong"; "never trade a working
default for a knob." The Playwright install deliberately sits at Playwright's
*default* `$HOME/.cache/ms-playwright` specifically so it needs **no** new
`CEZ_*` env var and **no** `.env.example` change — which also means the
`.env.example`-must-update-in-the-same-commit rule (`AGENTS.md:263`) does not
apply here, since this task adds no new env var. The doc should say this
explicitly (the zero-env-var property is the whole point, not an incidental
detail) so a future session doesn't "fix" it by adding
`PLAYWRIGHT_BROWSERS_PATH` to `CEZ_ENV_PASSTHROUGH` and break it, per the
brief's own stated trap.

## Verified on-box state (I am running directly on `prod-host`)

- `playwright --version` → `Version 1.62.1`, binary at `/usr/bin/playwright`.
- `$HOME/.cache/ms-playwright` (`/var/lib/cezar/.cache/ms-playwright`) exists,
  **1.2G**, and contains **four** browser dirs: `chromium-1234`,
  `chromium_headless_shell-1234`, `ffmpeg-1011`, **and also `firefox-1538` and
  `webkit-2336`**. **Discrepancy to resolve before the doc ships a number or a
  browser list**: the task handoff says "Chrome for Testing + chrome-headless-shell
  + ffmpeg ... 656MB" (Chromium-family only); the box today has Firefox and
  WebKit installed too, at roughly double that size. Either a broader
  `playwright install` ran after the 2026-08-21 verification, or the handoff
  under-described the install. The spec step should re-verify current size/
  browser set rather than copy the handoff's numbers, and the doc should
  either name all three engines or explicitly scope its verified-working claim
  to Chromium (which is what was actually exercised against example.com).
- `$HOME/.node_modules/playwright` and `.../playwright-core` are symlinks to
  `/usr/lib/node_modules/{playwright,playwright-core}` (confirmed via `ls -la`).
  `node -e "require('module').globalPaths"` → includes
  `/var/lib/cezar/.node_modules` — this is Node's own built-in global-folder
  lookup (not `NODE_PATH`), which is why a bare `require('playwright')` works
  from any cwd with no env var at all, matching the handoff's claim.
- `/etc/cezar/cloudflare.env` exists (0640 root:cezar, 413 bytes).
- `/etc/cezar/agent-env.env` exists and already lists `CLOUDFLARE_API_TOKEN`
  and `CLOUDFLARE_ACCOUNT_ID` in `CEZ_ENV_PASSTHROUGH` (see point 2 above).

## Which code/docs are actually involved

- `packages/cezar/src/core/agent-env.ts` — the allowlist and passthrough logic
  to cite (read-only reference for the doc; not to be changed by this task).
- `AGENTS.md` — the file to edit. Headings (`grep -n '^#'`):
  `1 # AGENTS.md`, `5 ## Shipping cezar itself`, `15 ## Zero config`,
  `30 ## Changing a mechanism that already works`, `161 ## The HTTP API`,
  `187 ## Repository layout`, `205 ## Task routing`, `225 ## Validation`
  (containing the `agent-browser`/e2e paragraph at 395-413),
  `415 ## How an agent step should spend its tool calls`,
  `528 ## Related documents`. No existing "Capabilities"/"Tools available to
  agents" section exists anywhere in the repo — this would be a new heading.
  Natural placement candidates: immediately after the `agent-browser`
  paragraph (~line 413, same neighborhood, invites the reconciliation in point
  3) or as its own top-level section before `## Related documents`. This is a
  call for the spec step, not settled here.
- `.ai/browsers/agent-browser.md` — related mechanism to cross-reference, not
  to modify.
- `/etc/cezar/agent-env.env`, `/etc/cezar/cloudflare.env` — host state to cite
  by path in the doc, not to change.
- `.ai/deploy-targets.json` exists but only documents deploy-readiness probes,
  not host tool capabilities — no convention to extend there.

## Prior decisions this would touch or could contradict if handled carelessly

- **`agent-browser`** (point 3): risk of the new section reading as a second,
  unexplained way to "drive a page." Needs one sentence positioning the two.
- **Zero-config doctrine** (point 4): risk of someone "helpfully" adding a
  `PLAYWRIGHT_BROWSERS_PATH` env var later, which the brief's own trap says
  breaks every agent silently. The doc must forbid this explicitly, not just
  describe the current working state.
- **CEZ_ENV_PASSTHROUGH already covers Cloudflare** (point 2): the doc must
  not repeat the handoff's "needs a wrapper" framing as if unresolved — that
  would be writing down something not simply undecided but factually already
  otherwise, the opposite of "read what already exists first."

## Open questions the spec step must settle

1. Exact wording for the `agent-browser` vs. raw-Playwright relationship —
   complementary tools for different jobs, or should the doc recommend one
   over the other for the "check a deployed URL renders" use case the
   acceptance criteria name (which `agent-browser`'s `open`/`snapshot`/
   `screenshot` ops can already do)?
2. Section placement in `AGENTS.md` (after line 413 vs. new top-level section
   vs. under `## Related documents`).
3. Whether this doc-only change also needs its own `.ai/specs/2026-08-22-*.md`
   spec file per the global CLAUDE.md "spec driven" rule (every non-trivial
   change gets a spec first), or whether an `AGENTS.md` edit of this shape has
   a lighter-weight established precedent in this repo (not found in this
   pass — worth a quick check next step).
4. How acceptance criterion 4 ("a real run uses the browser ... NDJSON shows a
   successful navigation") gets satisfied mechanically — a one-off manual
   navigation run as part of implementation, or a small persisted smoke script
   under `.ai/scripts/` that a future session can re-run. Given the global
   CLAUDE.md's "plan the test up front," this should be decided before writing
   the doc, not after.
5. Resolve the size/browser-engine discrepancy (1.2G/4 engines now vs.
   656MB/Chromium-only in the handoff) before committing specific numbers to
   the doc — re-verify at spec/implementation time.

## What I could NOT find

- No spec, KB entry, or commit records the 2026-08-21 install itself — it
  rests entirely on this task's own handoff context, corroborated by my own
  live checks on the box (which confirm the binary and cache exist, but not
  the original example.com/screenshot/env-stripped verification narrative —
  I did not re-run those checks in this step).
- No existing "Tools/Capabilities available to agents" section anywhere in
  `AGENTS.md` or the repo to extend — this is new structure.
- No branch, todo, or in-flight work duplicating this task (checked
  `git log --all`, `cezar todo list`, KB search, `.ai/cezar/knowledge-index`).
- Did not read the contents of `/etc/cezar/cloudflare.env` (secrets; existence
  and permissions only).

## Facts that most constrain the design

1. `PLAYWRIGHT_` and `CLOUDFLARE_` are absent from both `BASE_ALLOW_NAMES` and
   `BASE_ALLOW_PREFIXES` in `agent-env.ts:35-199`; `HOME`/`PATH` are present —
   this is why the install must stay at Playwright's *default* cache path.
2. `CEZ_ENV_PASSTHROUGH` in `/etc/cezar/agent-env.env` **already** includes
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` — the CF Browser
   Rendering fallback's credentials are already agent-visible today, not a
   TODO.
3. `AGENTS.md:395-413` + `.ai/browsers/agent-browser.md` already document a
   general-purpose, self-provisioning browser contract (`agent-browser`) —
   the new section must say how it relates to raw Playwright, not sit beside
   it unexplained.
4. The box's actual `ms-playwright` cache (1.2G, four browser engines) does
   not match the handoff's description (656MB, Chromium-only) — re-verify
   before the doc states specifics.
