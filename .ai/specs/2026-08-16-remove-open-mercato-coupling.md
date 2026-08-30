# Remove the Open Mercato vendor coupling

**Status:** implemented (2026-08-16)

## TLDR

This fork carries Open Mercato in four independent places, and the owner asked for all of
them gone: a **hardcoded vendor skills repo** that supplies 37 of the 47 skills in the live
catalog, a **terminal promo banner** on every `serve`, a **default-on auto-updater** written
specifically to update that repo's skills, and the **Open Mercato logo serving as the cockpit's
favicon and brand mark**. Underneath all four sits the npm scope itself — `@open-mercato/cezar`
and its three siblings, ~513 references across ~364 files.

All four go. The scope is renamed to `@loki-labs/cezar-plus*`. `DEFAULT_SKILLS_REPOS` becomes `[]`.

The dated record is **not** rewritten: `.ai/specs/`, `.ai/runs/`, `.ai/analysis/` and the
historical part of `CHANGELOG.md` keep saying Open Mercato, because that is what happened.

## Problem

`~/loki-labs/cezar` is a fork of `open-mercato/cezar`, 44 commits ahead, run as the owner's own
parallel-agents cockpit. It is not a contribution to the upstream project and is never published
under upstream's name — but nothing in the code knows that. Concretely, on a live cockpit:

| Surface | Evidence |
|---|---|
| Skills catalog | `GET /api/v1/skills` returns **47 skills, 37 of them `om-*`** — every one from the hardcoded `open-mercato/skills`. Only 10 are the owner's own. |
| Composer picker | Same 37, because `discoverSkills` is the single chokepoint for catalog, picker, planner and runner alike. |
| Terminal | `printSkillsBanner` prints a 5-line promo on every `serve` start (`index.ts:546`). |
| Background work | `SkillsUpdateService` checks and applies updates for `open-mercato/skills` entries, **on by default** (`CEZ_SKILLS_AUTO_UPDATE` inherits `true`). |
| Browser tab | The favicon is `packages/web/public/open-mercato.svg` — the Open Mercato company mark, also the app-shell brand tile. |
| Package identity | `@open-mercato/cezar`, `-web`, `-contract`, `-api-client`; the alias package publishes as unscoped `cezar-cli`, which is **upstream's own npm package name**. |

The vendor skills are not a neutral default. They are 79% of the catalog, they crowd the composer
picker, and `om-apply-upgrade-notes` is offered as a *run to start* from a dialog in the cockpit.

## Solution

Four phases, each independently revertable, in an order chosen so the mechanical rename lands last
and does not have to be redone as earlier phases delete files.

### A. The vendor skills source, banner and updater

- `DEFAULT_SKILLS_REPOS = []` (`config.ts`). The config key already documents `[]` as "disables",
  so this makes the documented opt-out the default rather than inventing a mechanism.
- Delete `skills-banner.ts`, its test, its `index.ts:546` call site, and `CEZ_NO_BANNER` — a
  switch for a banner that no longer exists is worse than no switch.
- Delete the **whole** skills-update feature, not just its branding: `skills-update.ts`, the three
  `/workspace/skills-update*` routes, the contract schemas, the api-client functions, the web
  update card, the settings toggle, `CEZ_SKILLS_AUTO_UPDATE`, and the `/om-apply-upgrade-notes`
  dialog. With no vendor repo there is nothing it can ever match — `isOpenMercatoSkillsSource`
  is the literal predicate it selects on. Keeping it would leave a live background job that can
  only ever answer "nothing tracked", which reads as working code to the next session.
- Delete `.ai/skills/om-prepare-test-env/`.
- Rewrite the Manage-skills panel: it stops naming a vendor and describes what it actually does.

**`gatedSkillsRepos` stays.** It is the opt-out gate for *any* default skills repo, not an
Open-Mercato-specific mechanism, and it becomes live again the moment someone configures a team
repo of their own in `.ai/cezar/config.json`.

### B. The brand mark

`packages/web/public/open-mercato.svg` is referenced from five places (`index.html`,
`app-shell.tsx`, `shell-routes.ts`, `static-ui.ts`, plus `pack-check` and `static-ui` tests that
assert the path). Replaced by `cezar.svg` at all five. The new mark is deliberately plain — it is
one file to swap.

### C. The npm scope

`@open-mercato/cezar{,-web,-contract,-api-client}` → `@loki-labs/cezar-plus*` (the owner's
choice, on the `@loki-labs/*` convention already used in the workspace). The unscoped alias
`cezar-cli` → `@loki-labs/cezar-plus-cli`:
`cezar-cli` is upstream's published package, and a fork that can attempt to publish over it is a
mistake waiting for a credential that happens to work.

### C2. D2 is partly superseded, and its guard is narrowed rather than deleted

The rename tripped a real, actively-maintained guard: `notifications/transports/webhook.test.ts`,
"upstream purity", which forbids `/loki|lokimessages|imsg/i` anywhere under
`packages/{cezar,web}/src` and reported **325 offending files** the moment the scope changed. It
enforces **D2 of `.ai/specs/2026-08-06-knowledge-base-mounts-search.md`** — "no Loki string ever
enters cezar `src/`, and a format named after one workspace is not upstreamable."

D2's *reason* is spent, because this fork is no longer upstreamable by decision. But the guard was
widened on 2026-08-06 after a real finding, and it protects a **second hazard D2 never named**: the
messaging product (`lokimessages`, `imsg`) leaking its URLs and internals into a coding cockpit that
knows nothing about it. That hazard survives the rename untouched.

So the guard is **narrowed, not lowered**: the fork's own specifier
(`/@loki-labs\/better-cezar(?:-[a-z-]+)?/g`) is **stripped from the file text before the scan**, and
the unchanged pattern then runs over what is left. Exempting by removal rather than by loosening the
pattern is what keeps a bare `loki` in prose — or any other `@loki-labs/*` package — still failing.
A new negative control pins exactly that, because a strip-based exemption is the part most likely to
rot into a blindfold:

```ts
expect(FORBIDDEN_RE.test(scannable("'@loki-labs/cezar-plus' posts to lokimessages.com"))).toBe(true)
expect(FORBIDDEN_RE.test(scannable('the loki workspace'))).toBe(true)
expect(FORBIDDEN_RE.test(scannable('@loki-labs/some-other-package'))).toBe(true)
```

D2 is marked **in place** in its own spec (amended Q10 rationale cell), not appended to, so a reader
scanning that table cannot carry away a rule the code no longer keeps.

### D. Docs

README, `.env.example`, `AGENTS.md` and `BACKWARD_COMPATIBILITY.md` are live documents and are
corrected. `BACKWARD_COMPATIBILITY.md` follows the correction rule: the removed contracts are
marked **in place**, not appended to, so a reader scanning it does not carry away a promise the
code no longer keeps.

## Architecture

The only non-obvious coupling is the skills chokepoint. `discoverSkills` merges six sources and
`filterImportedTeamSkills` gates only the *team* tier against `gatedSkillsRepos`. Emptying
`DEFAULT_SKILLS_REPOS` removes the team tier's only member, so the gate has nothing to gate and
the catalog falls back to the local and global tiers — the owner's own 10 skills. No call site
changes; the data does.

```
discoverSkills
  .ai/cezar/skills → .ai/skills → .agents/skills → ~/.agents/skills → ~/.claude/skills → TEAM
                                                                                          ↑
                                                            skillsRepos (was: open-mercato/skills,
                                                                          now: [] unless configured)
```

## Phases

| # | Phase | Independently revertable |
|---|---|---|
| A | Vendor skills source, banner, updater, `om-*` skill | yes |
| B | Brand mark | yes |
| C | npm scope rename | yes (mechanical) |
| D | Docs | yes |

## Data Models

- `WorkspaceConfig.skillsAutoUpdate` and the `SkillsUpdateState` / `SkillsUpdateScopeState` /
  `SkillsUpdateStatus` schemas are **removed** from `packages/contract/src/workspace.ts`.
- `WorkspaceUiState.dismissedSkillsBanner` is **removed**. It was already documented as legacy
  ("nothing writes it today"), and the banner it silenced is gone.
- `WorkspaceUiState.importedSkills` **stays**. It is the general curation list, not vendor state,
  and it survives to gate whatever team repo the owner configures next.

## API Contracts

Removed: `GET /api/v1/workspace/skills-update`, `POST /api/v1/workspace/skills-update/check`,
`POST /api/v1/workspace/skills-update/apply`. All three answered vendor-only state.

No other endpoint changes shape. The scope rename is a package-name change and touches no wire
format.

## Risks

1. **Every future `git merge upstream/main` now conflicts on essentially every file that imports
   anything.** This is the real cost of Phase C and it is permanent. Accepted deliberately by the
   owner: this fork is a private cockpit, not a contribution branch. Upstream was last merged at
   `a1301dd4` (0.9.3); a future merge is a manual re-application, not a fast-forward.
2. **The catalog drops from 47 skills to 10.** Intended, but it is a visible change to the
   composer picker and to any saved workflow step naming an `om-*` skill. Mitigated by the fact
   that a step whose `skill` does not resolve falls back to its plain prompt rather than failing —
   the existing documented behaviour, not a new hedge.
3. **`@loki-labs` may not be a scope the owner controls on npm.** Irrelevant while every package
   is either `private: true` or never published from this fork, and strictly safer than the status
   quo, where the manifests name a scope the owner definitely does not control.
4. **A stale `~/.cezar/ui-state.json` may still list `om-*` names in `importedSkills`.** Harmless:
   the list is filtered against skills that actually exist, so absent names are inert.

## Verification

Every guard names the mutation that must turn it red.

| Guard | File | Mutation |
|---|---|---|
| The default skills config offers no repo | `packages/cezar/src/config.test.ts` | Restore `open-mercato/skills` to `DEFAULT_SKILLS_REPOS` |
| No source file names Open Mercato outside the dated record | new structural test | Reintroduce the string anywhere under `packages/*/src` |
| The brand asset the server serves is the one the bundle asks for | `packages/cezar/src/server/static-ui.test.ts` | Point `index.html` at a path the allowlist omits |

Gates in order, **`npm test -- <path>`, never `npx vitest`**, judged by **exit code**:
`npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`.

**Runtime E2E — the gate on done.** A green suite cannot see a catalog that is populated from
disk and network at runtime.

1. Rebuild, restart the cockpit on `localhost:4321`.
2. `GET /api/v1/skills` returns **10 skills, zero `om-*`** (was 47 / 37).
3. The `serve` startup output contains no banner.
4. The browser tab favicon and the sidebar brand tile are the new mark, not the OM tile.
5. The Skills page shows the Manage panel with no update card and no vendor naming; Settings has
   no auto-update toggle.
6. `GET /api/v1/workspace/skills-update` answers 404.

## Not in this spec

- Turning on any of the off-by-default capability flags (`CEZ_KB`, `CEZ_NOTES`, `CEZ_SOURCES`,
  `CEZ_AUTOMATIONS`, `CEZ_NOTIFY`, `CEZ_WORKSPACE_VIEWS`). Separate decision.
- Configuring a replacement team skills repo. The owner chose an empty default; the config key is
  the supported way to add one later.
- Rewriting the dated record. `.ai/specs/`, `.ai/runs/`, `.ai/analysis/` and `CHANGELOG.md`
  history keep every Open Mercato reference they already have.
