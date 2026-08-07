import { isLocalOrgModeActive } from './server/capabilities.ts';
// The D4 root→org registry seam (`server/project-team-registry.ts`, extracted 2026-08-07 out of
// `server/server.ts#createApp` at D13 repair round 3, FIX 3) — statically importable here because
// it closes over nothing but `paths.ts`/`process.env` at module scope (no I/O; the local
// `IdentityStore` and the supervisor's `registry-client.ts` are both reached through DYNAMIC
// imports inside it, same discipline as everything else this file reaches). See
// `releaseProjectTeamClaim`'s own doc comment below for why this module needs it too.
import { openProjectTeamRegistry } from './server/project-team-registry.ts';
import { loadWorkspaceConfig, type WorkspaceProject } from './workspace/config.ts';
import { registerProject } from './workspace/projects.ts';

/**
 * D13's project registration/adoption seam (spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`)
 * — extracted out of `src/index.ts` for the same reason `./auth-boot-gate.ts` was extracted from
 * that same file earlier in this spec's history (see that module's own doc comment, point 1):
 * `src/index.ts` is the CLI entry, so importing it runs the CLI, and no unit test can reach a value
 * or a code path only ever constructed inline there without spawning a real `cezar serve` process.
 *
 * Three exports, one seam:
 *  - `listRegisteredProjectRoots` — the onboarding-time READ (unchanged from FIX 6, D13 repair
 *    round 1; see its own doc comment below).
 *  - `registerAndAdoptProject` — the registration WRITE every non-HTTP caller must go through
 *    (FIX A1/A3/A4, D13 repair round 2; see its own doc comment below).
 *  - `releaseProjectTeamClaim` — the un-registration WRITE's counterpart (FIX A2, D13 repair
 *    round 2; see its own doc comment below).
 *
 * `server.ts#registerFolder`/`#releaseRootClaim` are deliberately NOT rebuilt on top of this
 * module: the HTTP route already has a resolved `Principal` (a real session, or D13's local
 * principal once onboarded) and its own D4-aware team selection — folding it into this
 * no-principal seam would silently override an explicit `teamId` the caller asked for with
 * whatever `resolveLocalOrgIdentity` reports as the default team. This module is only for the
 * callers that have no principal to act as: boot registration and the offline CLI.
 */
/**
 * FIX 6 (D13 repair pass 1) — the production supplier `src/index.ts`'s local-mode branch threads
 * into `OnboardingRouteDeps.listRegisteredProjectRoots` (`auth/onboarding-routes.ts`), extracted
 * specifically so it HAS a test at all. See this module's own doc comment for why the un-extracted
 * inline version at the `src/index.ts` call site was invisible to every existing gate: deleting it
 * reproduces D13's own "an org whose project list is empty" FAIL state with the whole suite green,
 * because every D13 test injects its own stub for this dependency rather than the real thing.
 *
 * Deliberately a thin, one-line wrapper — the only thing worth asserting about it is that it reads
 * the SAME registry `src/index.ts#initWorkspace` and `cezar projects` already read, and returns
 * every root currently in it. `registered-project-roots.test.ts` seeds a real `~/.cezar/config.json`
 * through `workspace/projects.ts#registerProject` (never a fake) and reads this function's answer
 * back against it.
 */
export async function listRegisteredProjectRoots(): Promise<string[]> {
  return (await loadWorkspaceConfig()).projects.map((project) => project.root);
}

/**
 * FIX A1/A3/A4 (D13 repair round 2, `.ai/specs/2026-08-06-org-team-auth-onboarding.md`) — THE
 * registration seam every non-HTTP caller must go through.
 *
 * **FIX A1 — why this has to be ONE function, not a call site each.** D13 says "existing projects
 * are adopted, not stranded". Round 1 wired that into exactly one of the two non-HTTP places a
 * project gets registered: `src/index.ts#initWorkspace`'s boot-time auto-registration. `cezar
 * projects add <dir>` (`workspace/projects-cli.ts`) is a second, shipped, documented registration
 * path — round 1 left it calling `workspace/projects.ts#registerProject` directly, so a project
 * added this way was registered forever and never filed under the local org, reproducing D13's own
 * named FAIL state ("an org whose project list is empty is a FAIL, not a cosmetic gap") on every
 * `add`. Fixed here, once, rather than by pasting round 1's inline adoption call into
 * `projects-cli.ts` too — a THIRD hand-rolled copy of the same logic, and exactly the shape that let
 * FIX A3's guard go missing from the first copy without the second copy's test noticing. Both
 * `src/index.ts#initWorkspace` and `workspace/projects-cli.ts#addCommand` now call this one function
 * instead of `registerProject` directly.
 *
 * **FIX A3 — the guard.** Adoption only runs when `isLocalOrgModeActive` (`server/capabilities.ts`
 * — `CEZ_AUTH` unset AND the bind is loopback) holds — the identical two-part predicate
 * `server.ts`'s per-request principal resolution already applies before it will read or write
 * `<CEZ_HOME>/identity` for an unauthenticated request. Round 1's `initWorkspace` call site was
 * keyed on NEITHER half and ran on every topology, including a hosted `CEZ_AUTH=oidc` deployment:
 * a local org left over in `<CEZ_HOME>/identity` from before auth was turned on would silently keep
 * claiming every newly-registered project forever, on a deployment where that org has no business
 * claiming anything. `registered-project-roots.test.ts`'s
 * "does not adopt into a stale local org once CEZ_AUTH names a provider" case is the regression
 * control — it seeds a real local org, sets `CEZ_AUTH=oidc`, and asserts no `project_teams` claim
 * is created; reverting the guard to "always adopt" fails it. Its sibling, "does NOT adopt on a
 * hosted (non-loopback) bindHost" (ADDED D13 repair round 3, FIX 1), pins the OTHER half at THIS
 * call site specifically: it passes `{ bindHost: '0.0.0.0' }` with both `CEZ_AUTH` and `CEZ_REMOTE`
 * left unset, so it can only pass if `opts.bindHost` genuinely reaches `isLocalOrgModeActive` — the
 * pre-existing `CEZ_REMOTE=1` case above it varies the OTHER conjunct and left this one unpinned:
 * a mutation dropping the second argument (`isLocalOrgModeActive(process.env)`, silently defaulting
 * to loopback) changed no test outcome here even though `local-mode-boot.test.ts` already proved the
 * identical shape of mutation observable at ITS call site.
 *
 * **FIX 2 (D13 repair round 3) — why `opts.bindHost` is correctly left `undefined` whenever a
 * caller genuinely has no bind to pass, and that is a decided, argued default, not an accidental
 * omission.** `src/index.ts#serveCommand` already gets this right for the one caller that DOES have
 * a bind: it threads the real `--bind-host` value all the way through `initWorkspace` into this
 * function's `opts.bindHost` (see that file's own "FIX A3" comment). The gap was the callers that
 * have none — `workspace/projects-cli.ts#addCommand` (`cezar projects add`) and `initWorkspace`
 * itself when invoked from `cezar projects list` (`src/index.ts`'s `CEZ_SINGLE_PROJECT` branch),
 * both offline CLI subcommands with no server and no listening socket at all. `isLocalOrgModeActive`'s
 * bind conjunct exists to answer "would a REMOTE HTTP CLIENT be able to reach the socket this
 * process is about to listen on" (see D1/D13's own "the bootstrap claim... must be the bind, not
 * the provider" reasoning) — a question that presupposes a listening socket, and per this module's
 * own doc comment `cezar projects add` is explicitly meant to "work with no server running" at all
 * (`projects-cli.ts`'s own module doc). There is therefore no bind to learn for these two callers,
 * and inventing one (probing for a running `cezar serve` and asking IT for its bind) would be a
 * design change this repair round does not make — the CLI would still have nothing to probe on the
 * common path this function itself documents. Treating the invocation as administering THIS
 * MACHINE is the other option D13's repair round named, and it is the correct one: whoever can
 * execute `cezar projects add` under a given `CEZ_HOME` already has that `CEZ_HOME`'s full local
 * read/write power over `<CEZ_HOME>/identity/*.json` directly (the same trust D4's own per-org unix
 * user boundary already relies on — see D4's "isolation is a process per org", not a permission
 * bit). This guard cannot withhold anything from a caller who already has that. So `bindHost:
 * undefined` here is not "unknown, therefore assumed trusted" the way an HTTP request's *absent*
 * `Host` header would be (`isLoopbackHostHeader`'s fail-**CLOSED** contract, `server/capabilities.ts`
 * — a genuinely different case, an untrusted network input with nothing to fall back to); it is the
 * only value that correctly describes "there is no socket to ask about". Previously this was
 * justified by citing `isLocalOrgModeActive`'s own doc comment ("this function exists for the
 * callers that have no request to resolve one from at all") — that sentence explains why the
 * function has to exist as a standalone predicate rather than living inside a per-request resolver,
 * a *different* question from what its bind argument should read as for a CLI caller, which it never
 * actually answers. This paragraph is the argument that citation was missing.
 *
 * **The one risk this leaves open, named rather than swept under "administering this machine":**
 * `resolveAuthProvider`/`resolveCapabilities` read `process.env`, which for a CLI invocation is the
 * INVOKING SHELL's environment, not necessarily the deployment's. `systemd`'s `Environment=`/
 * `EnvironmentFile=` lines are scoped to that unit's own process tree — an operator's separate
 * interactive/SSH shell does not inherit them merely by sharing a `CEZ_HOME`. So on a hosted
 * deployment (ubuntu-vps's shared-shell topology, or an org unit under D10's supervisor) an operator
 * who runs `cezar projects add`/`remove` from a shell that has not sourced the real deployment's
 * environment gets BOTH conjuncts read from the wrong place, not only the bind — `CEZ_AUTH` reads
 * `'none'` there regardless of what the real server's unit sets. This is bounded, not
 * open-ended, and is why it is named rather than "fixed" by a third guard: `adoptRegisteredProjectIntoLocalOrg`
 * (`auth/local-identity.ts`) is a documented no-op unless a local org row ALREADY exists in whichever
 * `identity.json` this call resolves to — so a mismatched shell either does nothing (no local org has
 * ever been created against that `CEZ_HOME` — the common case) or misfiles the new registration under
 * whichever org already is there, which is a correctness bug (the wrong team gains a claim) but not a
 * new privilege: reaching that state already required running a command as a principal who could open
 * `<CEZ_HOME>/identity/*.json` by hand. An operator relying on `cezar projects add` on a hosted
 * deployment should run it under the SAME environment the deployment's unit uses. Do not "fix" this by
 * inventing a third spelling of the predicate (e.g. re-deriving it from `CEZ_HOME` contents) — one
 * exported `isLocalOrgModeActive(env, bindHost)` is the whole decision, everywhere.
 *
 * **FIX A4 — a registration that already succeeded must survive an adoption that didn't.** `entry`
 * is a real, persisted registry row the instant `registerProject` returns below, independent of
 * whatever happens next. An identity-store write failure during adoption (a stuck write lease, a
 * read-only `<CEZ_HOME>/identity`, a team deleted out from under a stale cache read) is caught and
 * logged HERE, inside this function, rather than left to propagate into a caller's own try/catch
 * (`initWorkspace`'s, before this fix) where it would silently discard `entry.id` — a boot value
 * that could not previously fail for a reason unrelated to it.
 */
export async function registerAndAdoptProject(
  root: string,
  opts: { source?: 'local' | 'checkout'; bindHost?: string } = {},
): Promise<WorkspaceProject> {
  const entry = await registerProject(root, opts.source);
  if (isLocalOrgModeActive(process.env, opts.bindHost)) {
    try {
      // Dynamic, string-literal imports — the same discipline every `./auth/*` reference in
      // `src/index.ts` already follows (see that file's own comments): these two modules must
      // never become part of the always-loaded npm-default module graph.
      const [{ adoptRegisteredProjectIntoLocalOrg }, { identityDir }] = await Promise.all([
        import('./auth/local-identity.ts'),
        import('./paths.ts'),
      ]);
      await adoptRegisteredProjectIntoLocalOrg(identityDir(), entry.root);
    } catch (err) {
      // FIX A4: the registration above already succeeded — say so, and keep it. Never rethrow.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[cez] could not file ${entry.root} under the local org (${message}) — the project is registered, just not yet organized`,
      );
    }
  }
  return entry;
}

/**
 * FIX A2 (D13 repair round 2) — the release half of the seam above. `cezar projects remove <id>`
 * (`workspace/projects-cli.ts`) drops the workspace-registry row but, unlike
 * `DELETE /api/v1/projects/:id` (`server.ts#releaseRootClaim`), has no HTTP request and no resolved
 * `Principal` to act as — round 1 left it never touching `<CEZ_HOME>/identity/*.json` at all, so
 * every CLI removal left its `project_teams` row behind. See `IdentityStore#deleteProjectTeam`'s
 * own doc comment for why that orphan is a real defect, not merely untidy: it makes the claiming
 * org's team permanently undeletable (`team-has-projects`, `identity-store.ts#deleteTeam`) even
 * once every project on it has been unregistered through the product — and if it was the org's
 * LAST team, `deleteTeam`'s own `team-is-last` guard means the org is now unrecoverable through the
 * product, full stop.
 *
 * **Read-then-write, never a bare `deleteProjectTeam` call.** `IdentityStore#guardedWrite`
 * unconditionally `mkdirSync`s `<CEZ_HOME>/identity` and takes the write lease, even for a no-op
 * delete — calling it on every removal, including the ordinary zero-config case where no org has
 * EVER existed, would itself create the identity directory the D1/D13 "no identity directory is
 * created" controls exist to keep absent. `IdentityStore#getProjectTeam` is a pure read (the
 * class's own doc comment: reads "never create state") — a claim can only exist if `identity.json`
 * already does, so finding one here means the directory this write touches is already real, never
 * newly conjured by this call. `server/project-team-registry.ts#ProjectTeamRegistry` preserves this
 * exact shape on both implementations it can return (see below).
 *
 * **Deliberately NOT gated on `isLocalOrgModeActive`, unlike `registerAndAdoptProject` above.**
 * This releases whatever claim genuinely exists for `root`, filed under ANY topology — an operator
 * running this CLI over ssh on a hosted `CEZ_AUTH=oidc` deployment must release a real
 * session-claimed root exactly as reliably as a local install releases its own local-org claim. The
 * two functions guard against opposite mistakes: registration must not FABRICATE a claim under a
 * possibly-stale identity; release must not LEAVE one behind, regardless of which identity claimed
 * it in the first place.
 *
 * **Not swallowed on failure**, mirroring `server.ts#releaseRootClaim`'s own documented discipline:
 * a write that fails here (e.g. a stuck lease) propagates rather than letting the CLI report a
 * clean removal that silently left an orphan behind.
 *
 * **FIX 3 (D13 repair round 3) — routed through `openProjectTeamRegistry`
 * (`server/project-team-registry.ts`), never `IdentityStore.open(identityDir())` directly.** This
 * function used to open the local identity store unconditionally, bypassing the ONE seam every
 * other D4 project-team write goes through (`server.ts`'s `withTeams`/`mayActOnRoot`/
 * `releaseRootClaim`/`registerFolder`, all of which ask `openProjectTeamRegistry` — see that
 * module's own doc comment). That was silently wrong on the D10 supervisor topology: an ORG
 * process's own `CEZ_HOME` carries no `identity/` directory at all (D10: the supervisor is the only
 * process that ever opens one), so `IdentityStore.open(identityDir())` here always opened an empty,
 * throwaway local store — `getProjectTeam` always answered "no claim", and `cezar projects remove`
 * silently left the REAL claim, held by the supervisor over HTTP, orphaned. Exactly the defect FIX
 * A2 above exists to close, reintroduced one layer down by not sharing its seam. Routing through
 * `openProjectTeamRegistry` fixes it for free: under `CEZ_AUTH=supervisor` it now calls the
 * supervisor's `DELETE /internal/project-teams/by-root` (`supervisor/registry-client.ts`, which is
 * itself idempotent and retried once on `unreachable` — see its own doc comment); every other
 * topology keeps reading the same local `IdentityStore` this function always has, byte-for-byte,
 * because `openProjectTeamRegistry`'s local branch is a thin wrapper over the identical calls.
 */
export async function releaseProjectTeamClaim(root: string): Promise<void> {
  const registry = await openProjectTeamRegistry();
  if (await registry.getProjectTeam(root)) {
    await registry.deleteProjectTeam(root);
  }
}
