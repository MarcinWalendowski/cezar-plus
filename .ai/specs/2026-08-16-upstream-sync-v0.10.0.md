# Upstream sync — v0.9.3 → v0.10.0 (`6a97d0ff..1912f2f2`)

**Date:** 2026-08-16 · **Status:** Spec — not implemented (planning only, no merge performed) ·
**Range:** `origin/main` (our fork) vs `upstream/main` = 11 commits · **Merge-base:** `6a97d0ff`
(the exact endpoint of the prior sync, `.ai/runs/2026-08-13-upstream-merge-triage/PLAN.md`).

Follows the method that prior triage established: **every commit is judged from its diff, not
its message**, bucketed Take/Skip, and the merge is planned around the *traps where a green gate
hides a broken merge*. This document is the plan; a later session executes it.

---

## TLDR

Upstream `open-mercato/cezar` advanced 11 commits (v0.9.3 → their v0.10.0). Two are
identity/release commits we resolve **away** (their version bump reverts our `@loki-labs`
rename; their README branding edit is a no-op against our tree). The other nine are real:
one reliability fix that **closes an outstanding defect the last sync left open** (§ SIGKILL),
one feature that **extends our own agent-accounts work**, two UI fixes, two test-hardening
commits that apply clean, and two reference specs.

**Recommended shape:** a single `git merge upstream/main` on a `sync/upstream-0.10.0` branch.
It conflicts in **11 files** (`git merge-tree`, verified in-memory) — 7 mechanical
identity/lockfile resolutions + 1 CHANGELOG union + **only 4 real code integrations**. Resolving
the manifests keep-ours is exactly what "skips" the upstream release commit. The merge advances
the merge-base to `1912f2f2`, so the next sync starts clean.

**Our divergence from upstream is almost entirely one mechanical fact:** the
`@open-mercato/cezar*` → `@loki-labs/better-cezar*` rename (plus additive features in new files).
Every web-file conflict below is the one import line; the two heavyweight files (`client.ts`,
`app-shell.tsx`) are our backup + agent-account-usage additions, and `app-shell.tsx` **auto-merges
anyway**.

---

## Problem

Our fork carries the central-hub programme (identity/orgs/teams, knowledge base, sources,
notifications, supervisor, hosted mode) and, as of this week, the encrypted platform backup
(`2026-08-16-provider-agnostic-platform-backup.md`) and agent-account-usage
(`2026-08-16-agent-account-usage-routing.md`). Upstream keeps shipping fixes and features on the
shared core. Left unsynced, our fork drifts from upstream bug fixes (leaked agent processes, a
broken sidebar on nightly builds, unvalidated history payloads) and misses features that build on
capabilities we already have (per-hand-off agent-account selection).

A straight `git merge upstream/main` is safe to *plan* but must be *resolved* deliberately: the
upstream release commit rewrites every `package.json` `name`/`version` back toward `@open-mercato`,
and the CHANGELOG carries our auth/orgs/backup record that a lazy "theirs" resolution deletes.

## Solution

Merge `upstream/main` into a `sync/upstream-0.10.0` branch off `origin/main`, resolve the 11
conflicts per the table below, run the full gate with the trap checks, then fast-forward `main`
and push **`origin` only** (never `upstream` — [[cezar-push-origin-never-upstream]]). A single
merge commit records the sync and advances the merge-base to `1912f2f2`.

Alternative considered — **cherry-pick only the wanted commits**: cleaner "selection" semantics,
but leaves the merge-base at `6a97d0ff`, so the two skipped commits (release, branding) re-list on
every future sync (the "compounds if deferred" cost the prior plan named). Rejected in favour of a
resolved merge, which skips them by construction *and* advances the base.

---

## Architecture — the divergence model

Two facts explain every conflict:

1. **The rename is mechanical and total.** `@open-mercato/cezar-contract|-api-client|-web|cezar`
   and the `cezar-cli` alias became `@loki-labs/better-cezar-*`. In web source this is a single
   `import` line per file, so any upstream commit touching such a file conflicts on exactly that
   line — resolved by keeping our specifier. (Verified: `engine-pills.tsx`, `run-history.ts`
   diffs are import-only.)
2. **Our features are additive and mostly in new files.** The only pre-existing files we grew
   materially are `packages/web/src/api/client.ts` (+646, backup + agent-account-usage methods)
   and `packages/web/src/components/app-shell.tsx` (+171). Everything else the merge auto-merges.

### Per-commit triage (read from diffs)

| sha | subject | verdict | why / conflict surface |
|---|---|---|---|
| `f851e7dc` | fix(runners): SIGKILL in the OpenCode watchdogs | **TAKE — clean** | **Closes prior sync §3.6.** Imports the already-present `trackChildExit` (from `f1c186ce`, taken last sync) into `opencode-server-runner.ts` — a file **untouched** in our fork. Leaked agent processes; matters more in hosted mode. No conflict. |
| `c3c0d92e` | feat(github): pick the agent account when handing an issue/PR to the agent | **TAKE — integrate** | **Extends our agent-accounts feature** to the GitHub hand-off. Cockpit-only, opt-in per surface. `agentProfile` is **already in our contract** (`runs.ts:176,706`) — no contract change. Conflicts: `engine-pills.tsx` (rename import), `hand-to-agent.tsx` (real hunk). |
| `bbade52d` | fix(shell): green Tools dot when the default runner works | **TAKE — integrate** | UI correctness. Conflict: `tools-menu.tsx` (rename import + logic hunk). |
| `cccd57fb` | fix(web): validate history route responses at client boundary | **TAKE — integrate** | Hardening on top of `bbd77e9b` (progressive history, taken last sync). Additive zod validation. Conflict: `client.ts` (heavy divergence — **the §2.1 type-break trap lives here**). `run-history.ts` auto-merges. |
| `89837ebb` | fix(cockpit): keep sidebar footer inside the column on a nightly version | **TAKE — auto-merges** | Self-contained `VersionChip` fix. **Matters more to us** — we ship nightly/snapshot dist-tags, so the 173px version string that broke the sidebar is our exact exposure. `app-shell.tsx` **auto-merges clean** despite +171 divergence. |
| `259d95b1` | test(server): realistic budget for health-topic probe waits | **TAKE — clean** | `health-topic.test.ts` untouched in our fork. Adds a spec doc. Test realism. |
| `b07ecd1e` | fix(tests): stop the JetBrains launcher case racing a real process | **TAKE — clean** | `open-in-app.test.ts` untouched. Test stability. |
| `e6b5693a` | docs(specs): Linked-PR chips on the GitHub Issues list | **TAKE — docs** | New spec + mockup assets, no code, no conflict. The *feature* (`b28495a0`) was **deferred** last sync (needs per-org `gh`); this is only its design doc. |
| `af240e7d` | docs(specs): design publishable Cezar React components | **TAKE — docs** | New 1142-line design spec, no conflict. Reference only. |
| `0a2fcc21` | docs: disambiguate cezar (OSS) from `<SAAS_NAME>` | **SKIP (inert)** | Removes a "Relationship to cezar (the SaaS)" README section **our fork no longer has** (gone via `2026-08-16-remove-open-mercato-coupling`). Auto-merges as a no-op; verify README post-merge. |
| `1912f2f2` | chore(release): bump main to 0.10.0 + changelog | **SKIP (resolve away)** | Upstream's own release. Rewrites every manifest `name`/`version` toward `@open-mercato`; we already cut our own `v0.10.0` (`bd902c06`). Resolved by keep-ours on the 6 manifests + package-lock regen + CHANGELOG union. |

### Conflict-resolution table (`git merge-tree`, 11 files)

| file | resolution |
|---|---|
| `packages/contract/package.json` | **keep ours** (`@loki-labs/better-cezar-contract`, 0.10.0) |
| `packages/api-client/package.json` | **keep ours** (name, version, `^0.10.0` internal pin) |
| `packages/cezar/package.json` | **keep ours** |
| `packages/web/package.json` | **keep ours** (`@loki-labs/better-cezar-web`) |
| `alias-cezar/package.json` | **keep ours** (name, version, pin, `repository` field) |
| `package-lock.json` | **do not hand-merge** — resolve manifests first, then `npm install` to regenerate |
| `CHANGELOG.md` | **union** — keep our auth/orgs/backup record incl. `CORRECTED` lead-ins (doctrine 3a); add upstream's new entries. Taking "theirs" deletes our record. |
| `packages/web/src/api/client.ts` | **integrate** `cccd57fb` additively into our diverged file; keep all backup + agent-account methods |
| `packages/web/src/components/engine-pills.tsx` | resolve import to `@loki-labs`; **take** upstream's `account` additions (`c3c0d92e`) |
| `packages/web/src/components/tools-menu.tsx` | resolve import to `@loki-labs`; **take** upstream's tools-dot fix (`bbade52d`) |
| `packages/web/src/routes/github/hand-to-agent.tsx` | **take** upstream's account-picker hunk (`c3c0d92e`) |

Auto-merged (no conflict, verified): `app-shell.tsx`, `run-history.ts`, `github.tsx`, `inbox.tsx`,
`github-task.ts`, `README.md`, and every touched `*.test.ts(x)`.

---

## Phases

1. **Branch + dry-run (session model).** `git fetch upstream` (done), branch
   `sync/upstream-0.10.0` off `origin/main`, `git merge --no-commit --no-ff upstream/main`,
   confirm the 11-file conflict set matches this spec.
2. **Identity resolutions (mechanical — delegatable).** 6 manifests keep-ours; `npm install` to
   regenerate `package-lock.json`; CHANGELOG union. This resolves/​skips `1912f2f2`.
3. **Code integration (session model — merge judgement).** The 4 code files. Resolve import lines
   to `@loki-labs`; integrate `c3c0d92e` / `bbade52d` / `cccd57fb` additively.
4. **Gate + trap checks (session model).** `typecheck` **first** (§ Risks R1), then `test`,
   `test:unit`, `build`, `test:package`. Add the flag-off / route-parity checks the traps call for.
5. **Land (session model).** Merge commit, fast-forward `main`, push `origin main`. Then Notion:
   flip the Tasks row to QA Needed and add a dated Changelog entry (Area `Cezar`).

Phase 2 is construction (→ `spec-implementer`, Sonnet 5). Phases 3–4 are merge-conflict judgement
and stay on the session model.

## Data Models / API Contracts

**No contract change.** `c3c0d92e` consumes `agentProfile`, already present in `CreateRunInput`
(`packages/contract/src/runs.ts:176` and the workspace-run-start body at `:706`). `cccd57fb` adds
client-side response validation only (no wire change). No `capabilitiesSchema` addition in the
range, so no health-fixture tax and no route-parity byte-identity risk from new capability keys.

## Risks (the traps a green gate can hide)

- **R1 — type break outside the conflict block (`client.ts`).** Prior §2.1: resolving the visible
  markers is not enough. `tsc` dies on markers first, so a residual type error surfaces only after
  the file *looks* done. Mitigation: run `typecheck` as the first gate, treat a clean typecheck as
  a precondition, not a formality.
- **R2 — CHANGELOG "theirs" deletes our record.** Union only; verify our `CORRECTED`/auth/orgs/
  backup lines survive.
- **R3 — package-lock hand-merge corruption.** Never resolve the lockfile by hand; regenerate.
- **R4 — README no-op assumption.** `0a2fcc21` auto-merges; eyeball the rendered README to confirm
  nothing we own (CEZ_BACKUP row, `@loki-labs` naming) was disturbed.
- **R5 — the local `v0.10.0` tag collides with upstream's.** Upstream ships its own `v0.10.0` tag
  (`1912f2f2`); a `--tags` fetch re-creates the local tag pointing at *their* commit. Our release
  tag on origin is `bd902c06` and authoritative. Re-point/verify the local tag after any upstream
  fetch, and never `git push --tags`.
- **R6 — never push to `upstream`.** Standing rule; name the remote on every push
  (`git push origin main`). [[cezar-push-origin-never-upstream]].

## Verification

- **Gate (5 commands, all green):** `typecheck` (first — R1), `test`, `test:unit`, `build`,
  `test:package`.
- **SIGKILL (`f851e7dc`):** `packages/cezar/src/core/opencode-server-runner.test.ts` green; the new
  watchdog escalation asserts a still-`killed` child is SIGKILLed.
- **Agent-account hand-off (`c3c0d92e`):** `github.test.tsx` + the inbox pin
  (`inbox.test.tsx` — the card must offer NO account picker, since `/todos/:id/start` ignores it).
- **Tools dot (`bbade52d`):** `tools-menu.test.tsx`.
- **History validation (`cccd57fb`):** `client.test.ts` + `run-history.test.tsx`.
- **Sidebar footer (`89837ebb`):** `app-shell.test.tsx` (which item truncates) — the e2e is
  upstream's and needs a browser provider, so runtime E2E stays QA Needed.
- **Post-merge sanity:** `git merge-base origin/main upstream/main` now `1912f2f2`; the 6 manifests
  still name `@loki-labs/better-cezar*` at 0.10.0; README unchanged where we own it.
- **Runtime E2E (Done vs QA Needed):** launch the cockpit, hand a GitHub issue to the agent picking
  a second claude login, confirm the run uses it; confirm the sidebar footer holds on a nightly
  version string. Until run: **QA Needed**.

## Notion

Spec-only session, so per the prior plan's §6 rule: create **one ✅ Tasks row** tagged `Cezar`,
Status **Todo**, pointing at this spec (cezar keeps its own specs; the task carries the pointer, not
the body). The dated 📝 Changelog entry (Area `Cezar`) is written **when the merge lands**, not now.
