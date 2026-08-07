import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  IdentityStore,
  IdentityStoreError,
  LOCAL_USER_ISSUER,
  LOCAL_USER_SUBJECT,
} from './identity-store.ts';
import type { SessionIdentity } from './principal.ts';

/** Mirrors `identity-store.ts`'s own private `SNAPSHOT_FILE` constant. Not imported — this
 *  module's scope is fixed (see `.ai/specs/2026-08-06-org-team-auth-onboarding.md` D13's repair
 *  round 4) to `local-identity.ts`/`local-identity.test.ts` alone, and the constant is private to
 *  `identity-store.ts`. `local-identity.test.ts` already spells this literal directly for the same
 *  reason (`join(dir, 'identity.json')`), so duplicating it here matches existing practice rather
 *  than inventing a new one. */
const IDENTITY_SNAPSHOT_FILE = 'identity.json';

/** One `identity.json`'s worth of change-detection state: its size and mtime as of the last
 *  `statSync`. Two dimensions, not one — a rewrite that happens to land in the same OS mtime tick
 *  (coarse filesystem clock resolution) is still almost always a different size, since every write
 *  this store makes changes the shape of at least one row; the pair is what makes the "always
 *  noticed" claim below hold in practice, not either field alone. */
interface SnapshotFingerprint {
  readonly size: number;
  readonly mtimeMs: number;
}

function sameFingerprint(
  a: SnapshotFingerprint | null,
  b: SnapshotFingerprint | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** One `statSync` on `identity.json`, degraded to `null` on `ENOENT` exactly the way
 *  `IdentityStore#readSnapshot`'s own `existsSync` check degrades a missing file — never creates
 *  the directory or the file, never throws for the ordinary "not onboarded yet" case. Any other
 *  error (e.g. a permissions problem) is real and is allowed to propagate rather than being read as
 *  "no file". */
function snapshotFingerprint(dir: string): SnapshotFingerprint | null {
  try {
    const stats = statSync(join(dir, IDENTITY_SNAPSHOT_FILE));
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * D13's local-org resolver (`.ai/specs/2026-08-06-org-team-auth-onboarding.md`) — turns "has this
 * `CEZ_HOME` been onboarded into a local org" into a `SessionIdentity` or `null`, cheaply enough to
 * call on every auth-off request.
 *
 * **FIX (adversarial review round 4, 2026-08-07): the process-lifetime cache below was the defect
 * three straight review rounds kept reopening, not a feature.** The original design cached the
 * resolved answer — including a `'none'` miss — for the whole process lifetime, invalidated only by
 * `invalidateLocalOrgIdentityCache()`, called only by the write path that ran IN THIS process.
 * `<CEZ_HOME>/identity/identity.json` is machine-global (D4: one `CEZ_HOME` per org, but nothing
 * stops two `cezar serve` processes pointed at the same one, or a `cezar projects add` CLI
 * invocation running alongside a long-lived server), so a second reader that was running when the
 * first one onboarded stayed stale for its entire remaining lifetime — filing every project it
 * registered under no org, silently, forever. Exactly the "an org whose project list is incomplete
 * and nothing backfills it" state D13 itself names as a FAIL, reached through a door in-process
 * invalidation could not close.
 *
 * **The fix: stop trusting the cached answer blindly and start trusting `identity.json` itself.**
 * Every call pays one `statSync` (`snapshotFingerprint` above) and compares its `{size, mtimeMs}`
 * against the fingerprint the cache was last built from. Same fingerprint → the file has not moved
 * since this process last looked, so the cached answer is returned with no parse. Different
 * fingerprint → some writer (this process or another) changed the file since, so the real reads
 * (`IdentityStore#getUserByIssuerSubject`/`#listMemberships`/`#listTeams`) run again and the cache is
 * rebuilt. Correctness no longer depends on which process performed the write — only on whether the
 * file changed, which every writer's `renameSync` (`identity-store.ts`'s `writeSnapshot`) makes true
 * of every successful write, in-process or not.
 *
 * **One asymmetry, deliberate: a `'resolved'` cache is sticky against the file DISAPPEARING, not
 * against it CHANGING.** `resolveLocalOrgIdentity` re-reads a resolved cache when the current
 * fingerprint is non-null and different (the file still exists but says something else — e.g. D13's
 * two required cross-process cases below), but keeps serving the last resolved identity when the
 * current fingerprint is `null` (no file). Two reasons this is the right split rather than a
 * shortcut: (1) nothing in this store's own write path ever unlinks `identity.json` without
 * immediately replacing it — `writeSnapshot` renames a temp file over the real one atomically, so a
 * legitimate writer never leaves the path missing; a missing file after a prior successful resolve
 * can only mean out-of-band deletion, outside anything D13 or this module claims to handle. (2) D13
 * itself: "local mode is single-org" — `claimOrg`'s `orgs.length > 0` guard means a locally-resolved
 * org is a terminal fact for the life of this `CEZ_HOME`, so treating its disappearance as "revert to
 * unonboarded" would let a transient or accidental deletion silently strand every request this
 * process is mid-handling far more destructively than serving one process's last-known-good answer
 * does. A `'none'` cache carries no such asymmetry — the whole point of this fix is that "no org yet"
 * must never be trusted past the moment the file says otherwise.
 *
 * **Why still a single global slot, not a cache keyed by directory.** Under D4, `<CEZ_HOME>` (and
 * therefore `identityDir()`) is fixed for the lifetime of one `cezar serve` process — there is
 * exactly one local org, ever, to resolve (D13: "local mode is single-org"). This module doesn't
 * need to distinguish "which `CEZ_HOME`" because a real process never has more than one. (Tests that
 * exercise more than one `CEZ_HOME` in a single process — inevitable in a suite — must still call
 * `invalidateLocalOrgIdentityCache()` between cases to get a clean starting state; see this file's
 * own test.)
 */
type LocalOrgCacheState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'none'; readonly fingerprint: SnapshotFingerprint | null }
  | {
      readonly kind: 'resolved';
      readonly identity: SessionIdentity;
      readonly fingerprint: SnapshotFingerprint;
    };

let cache: LocalOrgCacheState = { kind: 'unknown' };

/**
 * Resolve the local org identity for `dir` (an already-computed `identityDir()` — this module
 * takes it as a parameter rather than importing `paths.ts#identityDir` itself, matching
 * `IdentityStore.open(dir)`'s own convention, and keeping this module trivially testable against a
 * temp directory the way `identity-store.test.ts` already tests `IdentityStore` itself).
 *
 * Deliberately SYNCHRONOUS — every read this calls into (`snapshotFingerprint`,
 * `IdentityStore#getUserByIssuerSubject`, `#listMemberships`, `#listTeams`) already is, and D6/D10's
 * `SessionResolver` contract (`server/server.ts`) is sync by construction: `SocketHub`'s WS-upgrade
 * callback has nowhere to `await`. Whoever wires this into `resolvePrincipal`'s new local-org input
 * arm (`auth/principal.ts`) can therefore call it from both the HTTP and the WS path with no
 * special-casing.
 *
 * Mirrors `session.ts#resolveIdentity`'s own "oldest membership, oldest team" selection exactly
 * (`listMemberships(userId)[0]`, `listTeams(orgId)[0]`) — not a second policy invented here: D13's
 * local user can only ever have the ONE membership `claimOrg`'s legacy branch grants it (local
 * mode never redeems an invite, never claims a second org), so "oldest" and "only" coincide, but
 * reusing the exact same selection is what keeps this resolver and the session one from being two
 * places that could someday disagree about which membership "the" one is.
 *
 * Returns `null` for "no local user row yet", "a local user row with no membership yet" (the
 * narrow window between `findOrCreateLocalUser` and `claimOrg` being two separate writes) and "a
 * membership with no team" (should be unreachable — `claimOrg`/`createOrg` always create a team in
 * the SAME write as the org — but degraded to `null` rather than thrown, the same fail-closed
 * posture `session.ts#resolveIdentity` already takes for the identical defensive case). None of
 * these partial states are cached as `'none'` forever — see the module doc comment above for how the
 * fingerprint check keeps them from surviving past the write that resolves them, cross-process or
 * not.
 */
export function resolveLocalOrgIdentity(dir: string): SessionIdentity | null {
  const fingerprint = snapshotFingerprint(dir);

  if (cache.kind === 'resolved') {
    if (fingerprint !== null && !sameFingerprint(fingerprint, cache.fingerprint)) {
      return readAndCache(dir, fingerprint);
    }
    return cache.identity;
  }

  if (cache.kind === 'none' && sameFingerprint(fingerprint, cache.fingerprint)) {
    return null;
  }

  // cache.kind === 'unknown' (first call ever), or a 'none' cache whose fingerprint has moved —
  // either way `identity.json` may now say something new, so do the real reads.
  return readAndCache(dir, fingerprint);
}

function readAndCache(
  dir: string,
  fingerprint: SnapshotFingerprint | null,
): SessionIdentity | null {
  const store = IdentityStore.open(dir);
  const user = store.getUserByIssuerSubject(LOCAL_USER_ISSUER, LOCAL_USER_SUBJECT);
  const membership = user ? store.listMemberships(user.id)[0] : undefined;
  const team = membership ? store.listTeams(membership.orgId)[0] : undefined;

  if (!user || !membership || !team) {
    cache = { kind: 'none', fingerprint };
    return null;
  }

  const identity: SessionIdentity = {
    userId: user.id,
    orgId: membership.orgId,
    teamId: team.id,
    role: membership.role,
  };
  if (fingerprint === null) {
    // The read above found a resolved identity, but the fingerprint taken just before it is
    // `null` — the file existed enough to resolve, then vanished before the stat, or vice versa. A
    // race outside anything D4's single-writer-at-a-time model expects, and rare enough that the
    // safe answer is "don't cache a fingerprint we don't have": return the identity for THIS call,
    // but leave the cache `'unknown'` so the next call re-reads for real rather than trusting a
    // fabricated one.
    cache = { kind: 'unknown' };
    return identity;
  }
  cache = { kind: 'resolved', identity, fingerprint };
  return identity;
}

/**
 * The in-process invalidator the onboarding write calls the instant it successfully writes the
 * local user's org. Still useful now that `resolveLocalOrgIdentity` also detects a changed file on
 * its own (see the module doc comment's FIX paragraph): this is belt-and-suspenders for the
 * SAME-process caller who wrote the change — it guarantees an unconditional fresh read on the very
 * next call regardless of filesystem mtime granularity, rather than relying on the fingerprint
 * having moved. Cross-process readers have no way to call this at all, which is exactly why they
 * needed the fingerprint check instead. Tests that exercise more than one `identityDir()` within a
 * single process must also call this between cases, since the cache is a single global slot (see
 * this file's own module doc for why that's the right shape in production).
 *
 * Resets to `'unknown'`, not directly to `'resolved'` with a caller-supplied identity: the next
 * `resolveLocalOrgIdentity` call re-reads the store fresh rather than trusting whatever the write
 * path believes it just wrote, the same "read what was actually persisted, not what you meant to
 * persist" discipline `IdentityStore#guardedWrite` itself already applies (re-reading the snapshot
 * under the lease rather than trusting an in-memory copy).
 */
export function invalidateLocalOrgIdentityCache(): void {
  cache = { kind: 'unknown' };
}

/**
 * **FIX (D13 repair pass): "adopted, not stranded" is not a one-time event.** D13's own text says
 * "Existing projects are adopted, not stranded" and its landed mechanism —
 * `OnboardingRouteDeps.listRegisteredProjectRoots`, read once inside `POST /auth/onboarding/org`'s
 * legacy branch — only ever sees the projects `workspace/config.ts`'s registry held AT THE MOMENT
 * the wizard runs. A project registered on a LATER boot (a second repo's `cezar serve`, boot-time
 * auto-registration via `src/index.ts#initWorkspace`) writes straight into the workspace registry
 * through `workspace/projects.ts#registerProject` with no principal and no org — that write has no
 * HTTP request behind it to resolve either from — so nothing else ever files it under an org that,
 * by then, may already exist. That reproduces D13's own named FAIL state ("an org whose project
 * list is empty is a FAIL, not a cosmetic gap") on every boot after the first, not only the one the
 * onboarding-time adoption covers.
 *
 * Fixed AT THE POINT OF REGISTRATION, not with a second periodic backfill pass: call this right
 * after any direct (non-HTTP) `registerProject` write — the same job `server.ts#registerFolder`'s
 * own claim block already does inline for the HTTP-registered case, using the caller's resolved
 * `Principal` instead of this module's cache.
 *
 * A no-op — one `resolveLocalOrgIdentity` read, this module's own cheap per-call fingerprint check
 * (see the module doc comment above) — when no local org exists yet: there is nothing to file under
 * yet, and D13's onboarding-time adoption is what will pick this root up once the wizard eventually
 * runs. Idempotent once a claim already exists for `projectRoot` (a re-run of `cezar serve` against
 * an already-filed boot project, or a root this SAME call already adopted on an earlier boot of this
 * process) — `project-root-taken` is caught and swallowed rather than surfaced to a caller
 * (boot-time registration) that has nowhere useful to report an error.
 *
 * Takes an already-normalized root (`workspace/projects.ts#registerProject`'s own return value is
 * exactly that), like `IdentityStore#createProjectTeam` expects from every other caller of it —
 * this function does not re-derive or re-validate the path, it only decides WHETHER to file it.
 */
export async function adoptRegisteredProjectIntoLocalOrg(
  dir: string,
  projectRoot: string,
): Promise<void> {
  const identity = resolveLocalOrgIdentity(dir);
  if (!identity) return;
  const store = IdentityStore.open(dir);
  try {
    await store.createProjectTeam({
      projectRoot,
      orgId: identity.orgId,
      teamId: identity.teamId,
    });
  } catch (error) {
    if (error instanceof IdentityStoreError && error.code === 'project-root-taken') return;
    throw error;
  }
}
