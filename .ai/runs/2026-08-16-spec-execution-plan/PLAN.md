# Staged execution of the pending cezar specs — 2026-08-16

**Owner ask:** "run everything from specs in stages with multiple subagents." **Status:** Stage 1
in progress. This plan triages every pending spec, buckets by readiness, and stages the buildable
work. Triaged 2026-08-16 by 8 parallel read-only agents (one per candidate spec); readiness read
from each spec's own text, not its title.

## Ground rules (this checkout)

- **Shared checkout, 80+ live sessions.** `spec-implementer` must not `git add -A` / `git stash`,
  and does **not** commit (its standing rule). The orchestrator (session model) reviews each
  implementer's diff, stages **only that lane's files**, commits **one commit per spec**, and pushes.
- **Serial, not parallel worktrees.** `node_modules` is gitignored and absent in a fresh worktree,
  so parallel isolation would need one full `npm install` per lane; and concurrent `npm run build`
  in one tree collides on `dist/`. For 3 small/medium lanes + 1 merge that overhead isn't worth it —
  run one `spec-implementer` at a time in the main checkout, land, then the next.
- **Gate = 5 commands, judged by exit code:** `typecheck`, `test`, `test:unit`, `build`,
  `test:package`. **No lint, no format** (none configured).
- **Push `origin` only, never `upstream`. Never bare `git push`.** (`git push origin main`.)
- **Done vs QA Needed:** gates green is necessary, not sufficient. The runtime/device E2Es
  (Hetzner VPS for org-team-auth, browser passes) are owner work — the plan ships **QA Needed**.

## Triage — the pending set is four buckets, not one fan-out

| Spec | Readiness | Size | Bucket / note |
|---|---|---|---|
| `2026-08-15-duplicate-project-context-wipes-runs` | READY | M | **Stage 1** — live DATA-LOSS bug (two stores over one `runs.json`, empty one truncates). **First.** |
| `2026-08-14-nested-repos-as-projects` | READY | M | **Stage 1** — no open decisions; supersedes parts of `2026-08-06-nested-repos-cockpit-scope`. |
| `2026-08-15-bypass-permissions-claude-sessions` | READY | S | **Stage 1** — ⚠️ security: all Claude sessions run with no permission gate. Owner confirmed 2026-08-16. |
| `2026-08-16-upstream-sync-v0.10.0` | READY | M | **Stage 1** — a merge (session-model judgement), not a `spec-implementer` build. |
| `2026-08-06-org-team-auth-onboarding` | NEEDS-DECISION | L | **Stage 2** — mostly already built (`auth/`, `supervisor/` shipped). 3 open decisions + live-host E2E. |
| `2026-08-14-workspace-level-navigation` Ph2/Ph3 | Ph2 done (QA) / Ph3 NEEDS-DECISION | L/M | **Stage 2** — Ph2 sub-specs already implemented; Ph3 blocked on board-consolidation decision. |
| `2026-08-07-org-scoped-tasks-knowledge` | READY* | L | **Stage 2** — *after* org-team-auth decisions + `workspace-notes-cross-project`. |
| `2026-08-06-inbound-agent-control-channel` | Ph1 ready / Ph2 BLOCKED | L | **Stage 3** — spans cezar **and** chat repos; Ph2 needs the shared-instance auth decision. |
| `2026-08-06-ops-board-notion-cutover` | BLOCKED | L | **Stage 3** — needs 7 days of `report_issue` D1/Notion agreement **and** an owner auth decision. |
| `2026-08-15-composer-stops-forcing-choices` | reverted | — | skip — D1/D2 reverted on owner review. |
| `2026-08-06-nested-repos-cockpit-scope` | superseded | — | skip — folded into `nested-repos-as-projects`. |

## Owner-decision gate (blocks Stage 2/3)

- **A. org-team-auth (3):** which side of the auth line `teamId` PATCH falls on; can an `admin`
  mint an `owner` invite; hostname-claim-routing vs `orgSlug`. → unblocks org-scoped-tasks-knowledge.
- **B. Board consolidation:** retire `/workspace/tasks` or `/tasks` (merge-triage §5). → Ph3.
- **C. Shared-instance auth model** (long-lead). → inbound-control Ph2 **and** ops-board.
- **D. bypass-permissions security** — **confirmed yes, 2026-08-16.**

## Stage 1 — ready now (serial, one `spec-implementer` each; upstream-sync by session model)

Land order (each: build → 5-gate green → orchestrator commits one commit → push origin → Notion
QA-Needed + Changelog):

1. **duplicate-context data-loss fix** — decision resolved by orchestrator: registration of an
   already-boot/already-registered root is **idempotent** (return the existing project, no second
   context/store). Negative control: `runs.json` record count never decreases across a restart with
   no archive/delete, asserted on the file. *(in progress)*
2. **nested-repos-as-projects** — `workspace/nested-repos.ts` (bounded walk depth≤3, worktree
   markers excluded, cap 25 + `truncated`), `GET /api/v1/projects/scan`, add-project review dialog.
3. **bypass-permissions** — `buildClaudeArgs` → `bypassPermissions`, drop `CEZ_APPROVAL_GATE`,
   correct the docblock, README + CHANGELOG (breaking + fix).
4. **upstream-sync v0.10.0 merge** — session model; per `2026-08-16-upstream-sync-v0.10.0.md`.

## Stage 2 — after decisions A/B

org-team-auth (resolve the 3 decisions, finish roster/removal + `teamId` gate; QA Needed) →
org-scoped-tasks-knowledge (L, 5 phases) → workspace-nav Ph3 (after B).

## Stage 3 — blocked / long-lead (tracked, not this run)

inbound-agent-control-channel (cross-repo; Ph2 needs C) · ops-board-notion-cutover (7-day precondition + C).
