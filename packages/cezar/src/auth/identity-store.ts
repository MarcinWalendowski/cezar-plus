import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  emptyIdentitySnapshot,
  identitySnapshotSchema,
  inviteSchema,
  membershipSchema,
  orgSchema,
  projectTeamSchema,
  sessionSchema,
  teamSchema,
  userSchema,
  type IdentitySnapshot,
  type Invite,
  type Membership,
  type Org,
  type ProjectTeam,
  type Role,
  type Session,
  type Team,
  type User,
} from './types.ts';

const SNAPSHOT_FILE = 'identity.json';
const LOCK_FILE = 'identity.lock';

/** Cap on the exponential backoff between lease retries — see `IdentityStore`'s module doc for
 *  why writes retry-and-block instead of the sibling stores' "one shot, else undefined" idiom. */
const MAX_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type IdentityStoreErrorCode =
  | 'org-slug-taken'
  | 'team-slug-taken'
  | 'org-not-found'
  | 'team-not-found'
  | 'team-org-mismatch'
  | 'user-not-found'
  | 'membership-exists'
  | 'project-root-taken'
  | 'session-id-taken'
  | 'lease-timeout'
  // ---- D8 first-user bootstrap race (see `bootstrapFirstOrg`'s own doc comment) ----------------
  | 'org-already-bootstrapped'
  // ---- invites (scaffold addition — see `types.ts`'s `inviteSchema` doc comment) --------------
  | 'invite-id-taken'
  | 'invite-not-found'
  | 'invite-expired'
  | 'invite-already-consumed';

/** Thrown by every guarded write below in place of the SQL engine's constraint violation (D7:
 *  "every UNIQUE/PRIMARY KEY … is a check performed inside the write lease"). `code` is the part a
 *  caller (an onboarding/login route, not yet written) is expected to switch on to answer 404 vs
 *  409; `message` is for logs, not for a response body. */
export class IdentityStoreError extends Error {
  constructor(
    readonly code: IdentityStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityStoreError';
  }
}

export interface IdentityStoreOptions {
  warn?: (message: string) => void;
  now?: () => Date;
  /** How long a write waits for a contended lease before giving up and throwing `lease-timeout`
   *  (ms). Default 5s: under D4 this store is written only by the single supervisor process, so
   *  contention is two of ITS OWN concurrent requests at worst (an onboarding step and a login
   *  landing in the same moment) — real contention should clear in well under a second, and a much
   *  longer default would let a genuinely stuck writer (e.g. a lease file on a wedged network
   *  mount) hang a request indefinitely instead of failing loudly. */
  lockTimeoutMs?: number;
  /** First retry delay (ms); doubles each attempt up to `MAX_RETRY_DELAY_MS`. */
  lockRetryMs?: number;
  /** A held lease older than this is presumed abandoned by a crashed writer and reclaimed — same
   *  idiom and default as `AutomationStore`/`SourceStore`'s poll lease. */
  staleLeaseMs?: number;
}

export class IdentityLease {
  private released = false;

  constructor(
    private readonly path: string,
    private readonly fd: number,
  ) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.fd);
    try {
      unlinkSync(this.path);
    } catch {
      // Already removed during shutdown cleanup.
    }
  }
}

/**
 * `<CEZ_HOME>/identity/*.json` (D7), the storage half of D1/D3/D8/D9's org/team/user/session
 * model. Two departures from `SourceStore`/`AutomationStore`, both deliberate:
 *
 * 1. **One combined snapshot file (`identity.json`), not one file per table.** Every
 *    `UNIQUE`/`PRIMARY KEY` in the spec's SQL model crosses tables you'd otherwise have to open
 *    together anyway (`createProjectTeam` needs `orgs` AND `teams` to validate the team it was
 *    handed actually belongs to the org it was handed), so splitting them would just mean taking
 *    the lease once and reading N files instead of one — no isolation benefit, more moving parts.
 *
 * 2. **No in-memory cache — every read re-parses the file from disk.** `SessionResolver` (see
 *    `server/server.ts`'s own doc comment on it) is deliberately SYNCHRONOUS, because
 *    `SocketHub.attach()`'s WS-upgrade callback has nowhere to `await`, and reads for it flow
 *    through the same finders as everything else per D3 ("there is no separate resolution path for
 *    auth-on vs auth-off, and there is no separate one for HTTP vs WS either"). A resolver that
 *    trusted an in-memory snapshot loaded once at boot could hand out a Principal for a session
 *    another request had just revoked, or fail to find a membership another request had just
 *    granted — the exact kind of two-paths-disagree drift D3's own worked incident (knowledge base
 *    dead on the boot project) is about. `readFileSync` + `JSON.parse` on a file sized for "tens to
 *    thousands of rows" (D7) costs microseconds, so there is no performance case for caching it.
 *    `loadWorkspaceConfig`'s doc comment ("read on demand, never cached") is the same call for the
 *    same reason and is the precedent this follows.
 *
 * **Writes are the one thing that's `async`, unlike every sibling store.** A write that finds the
 * lease held retries with backoff instead of returning `undefined` the way
 * `SourceStore.acquireLease` does for its background poll — a poll can skip a cycle, but "your
 * onboarding step silently no-opped because another request happened to be writing at the same
 * instant" is not an acceptable failure mode for a user-facing action. Retrying needs somewhere to
 * `await`, which reads (called from the sync WS path above) cannot have — hence the asymmetry.
 *
 * **One guarded write helper, reused by every mutator.** Each public write method below supplies
 * only its own uniqueness/referential checks; `guardedWrite` is the only place that takes the
 * lease, re-reads the snapshot fresh (so a check can never run against data another writer already
 * changed underneath it), and writes+releases. This is what D7 asks for explicitly: "write it as
 * one guarded helper, not a check at each call site, or the guarantee decays to 'every caller
 * remembered'."
 */
export class IdentityStore {
  private readonly warned = new Set<string>();
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly staleLeaseMs: number;

  static open(dir: string, options: IdentityStoreOptions = {}): IdentityStore {
    return new IdentityStore(dir, options);
  }

  private constructor(
    readonly dir: string,
    private readonly options: IdentityStoreOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.lockRetryMs = options.lockRetryMs ?? 10;
    this.staleLeaseMs = options.staleLeaseMs ?? 10 * 60_000;
  }

  // ---- reads: always fresh off disk, never throw, never create state ---------------------------

  listOrgs(): Org[] {
    return this.readSnapshot().orgs;
  }

  getOrgById(id: string): Org | undefined {
    return this.readSnapshot().orgs.find((org) => org.id === id);
  }

  getOrgBySlug(slug: string): Org | undefined {
    return this.readSnapshot().orgs.find((org) => org.slug === slug);
  }

  listTeams(orgId: string): Team[] {
    return this.readSnapshot().teams.filter((team) => team.orgId === orgId);
  }

  getTeamById(id: string): Team | undefined {
    return this.readSnapshot().teams.find((team) => team.id === id);
  }

  getTeamBySlug(orgId: string, slug: string): Team | undefined {
    return this.readSnapshot().teams.find((team) => team.orgId === orgId && team.slug === slug);
  }

  getUserById(id: string): User | undefined {
    return this.readSnapshot().users.find((user) => user.id === id);
  }

  /** The only user lookup that matters for sign-in — see `types.ts`'s `userSchema` doc for why
   *  this, and never email, is the identity key. */
  getUserByIssuerSubject(issuer: string, subject: string): User | undefined {
    return this.readSnapshot().users.find((user) => user.issuer === issuer && user.subject === subject);
  }

  listMemberships(userId: string): Membership[] {
    return this.readSnapshot().memberships.filter((membership) => membership.userId === userId);
  }

  listOrgMembers(orgId: string): Membership[] {
    return this.readSnapshot().memberships.filter((membership) => membership.orgId === orgId);
  }

  getMembership(userId: string, orgId: string): Membership | undefined {
    return this.readSnapshot().memberships.find((membership) => membership.userId === userId && membership.orgId === orgId);
  }

  /** Filters are ANDed. Callers registering/looking up a specific root are expected to pass an
   *  already-`realpath`d value — see `createProjectTeam`'s own comment for why normalization is
   *  centralized at the one write site rather than repeated (and possibly forgotten) in every
   *  reader. */
  listProjectTeams(filter: { orgId?: string; teamId?: string } = {}): ProjectTeam[] {
    return this.readSnapshot().projectTeams.filter(
      (row) => (filter.orgId === undefined || row.orgId === filter.orgId) && (filter.teamId === undefined || row.teamId === filter.teamId),
    );
  }

  getProjectTeam(projectRoot: string): ProjectTeam | undefined {
    return this.readSnapshot().projectTeams.find((row) => row.projectRoot === projectRoot);
  }

  /** Expired sessions read as absent — never returns a row whose `expiresAt` has passed, so no
   *  caller (there will be exactly one today, `../auth/session.ts`, but the guarantee is meant to
   *  outlive that) can forget to re-check it, the same centralization principle D7 asks for around
   *  uniqueness applied to expiry. */
  getSession(id: string): Session | undefined {
    const session = this.readSnapshot().sessions.find((row) => row.id === id);
    if (!session) return undefined;
    return Date.parse(session.expiresAt) > this.now().getTime() ? session : undefined;
  }

  /**
   * Scaffold addition (see `types.ts`'s `inviteSchema` doc comment). Unexpired and unconsumed
   * only — the same "expiry is centralized in the store, never left to each caller" discipline
   * `getSession` above already applies, extended to cover consumption too: a caller asking "is
   * this invite still good" must get one answer, not have to separately remember to check both
   * `expiresAt` and `consumedAt` itself.
   */
  getInvite(id: string): Invite | undefined {
    const invite = this.readSnapshot().invites.find((row) => row.id === id);
    if (!invite) return undefined;
    if (invite.consumedAt) return undefined;
    return Date.parse(invite.expiresAt) > this.now().getTime() ? invite : undefined;
  }

  /** Every invite ever created for the org, expired/consumed included — an admin "invite
   *  history" view's job to filter, not this method's (mirrors `listOrgMembers`, which returns
   *  every membership rather than pre-filtering by role). */
  listOrgInvites(orgId: string): Invite[] {
    return this.readSnapshot().invites.filter((row) => row.orgId === orgId);
  }

  // ---- writes: async, retry-and-block on lease contention, one guarded helper ------------------

  /**
   * Creates an org AND its default team in the SAME write (D8: "a half-finished onboarding must
   * not strand an org with no team, so the default team is created on org creation and the step
   * only renames it"). There is deliberately no bare `createOrg` that skips the team — two separate
   * guarded writes would each be individually consistent but leave a window, if the process died
   * between them, where an org exists with no team; folding both inserts into one lease + one
   * atomic file write makes that window not exist rather than merely making it short.
   */
  async createOrg(
    input: { name: string; slug: string; defaultTeamName?: string; defaultTeamSlug?: string },
    ids: { orgId?: string; defaultTeamId?: string } = {},
  ): Promise<{ org: Org; defaultTeam: Team }> {
    return this.guardedWrite((snapshot) => {
      if (snapshot.orgs.some((org) => org.slug === input.slug)) {
        throw new IdentityStoreError('org-slug-taken', `an org with slug "${input.slug}" already exists`);
      }
      const org = orgSchema.parse({
        id: ids.orgId ?? randomUUID(),
        name: input.name,
        slug: input.slug,
        createdAt: this.now().toISOString(),
      });
      const team = teamSchema.parse({
        id: ids.defaultTeamId ?? randomUUID(),
        orgId: org.id,
        name: input.defaultTeamName ?? 'General',
        slug: input.defaultTeamSlug ?? 'general',
      });
      return {
        snapshot: { ...snapshot, orgs: [...snapshot.orgs, org], teams: [...snapshot.teams, team] },
        result: { org, defaultTeam: team },
      };
    });
  }

  /** A later (non-default) team — `engineering`, `marketing` per the spec's own example — added to
   *  an org that already exists. */
  async createTeam(input: { orgId: string; name: string; slug: string }, id?: string): Promise<Team> {
    return this.guardedWrite((snapshot) => {
      if (!snapshot.orgs.some((org) => org.id === input.orgId)) {
        throw new IdentityStoreError('org-not-found', `no org ${input.orgId}`);
      }
      if (snapshot.teams.some((team) => team.orgId === input.orgId && team.slug === input.slug)) {
        throw new IdentityStoreError('team-slug-taken', `org ${input.orgId} already has a team with slug "${input.slug}"`);
      }
      const team = teamSchema.parse({ id: id ?? randomUUID(), orgId: input.orgId, name: input.name, slug: input.slug });
      return { snapshot: { ...snapshot, teams: [...snapshot.teams, team] }, result: team };
    });
  }

  /** D8 step 3: onboarding suggests `General` and "the step only renames it" — the default team
   *  itself is created atomically with the org (`createOrg` above), so this is the only mutation
   *  that step needs. Slug is left untouched deliberately: renaming what a team is called should
   *  not silently move what a project's `project_teams` row or a saved filter points at. */
  async renameTeam(id: string, name: string): Promise<Team> {
    return this.guardedWrite((snapshot) => {
      const index = snapshot.teams.findIndex((team) => team.id === id);
      const existing = snapshot.teams[index];
      if (!existing) throw new IdentityStoreError('team-not-found', `no team ${id}`);
      const updated = teamSchema.parse({ ...existing, name });
      const teams = [...snapshot.teams];
      teams[index] = updated;
      return { snapshot: { ...snapshot, teams }, result: updated };
    });
  }

  /**
   * Find-or-create keyed on `(issuer, subject)`, atomically — a race between two requests hitting
   * the OIDC callback for the same identity at once (double-submitted form, two tabs) must produce
   * ONE user row, not a duplicate `(issuer, subject)` the schema's own uniqueness would otherwise
   * only catch after the fact. When the user already exists, `email`/`name` are refreshed from the
   * latest claims rather than left stale: they are deliberately NOT the identity key (see
   * `userSchema`'s doc) exactly because they can change at the IdP, so keeping the old value here
   * would reintroduce the problem keying identity on email was chosen to avoid.
   */
  async findOrCreateUser(input: {
    issuer: string;
    subject: string;
    email?: string;
    name?: string;
  }): Promise<{ user: User; created: boolean }> {
    // Explicit type argument: the two branches below return literal `created: true`/`created:
    // false`, and without pinning `T` up front TS infers it from whichever branch it visits first,
    // then rejects the other as a mismatch against that narrower literal.
    return this.guardedWrite<{ user: User; created: boolean }>((snapshot) => {
      const index = snapshot.users.findIndex((user) => user.issuer === input.issuer && user.subject === input.subject);
      const existing = snapshot.users[index];
      if (existing) {
        const updated = userSchema.parse({
          ...existing,
          email: input.email ?? existing.email,
          name: input.name ?? existing.name,
        });
        const users = [...snapshot.users];
        users[index] = updated;
        return { snapshot: { ...snapshot, users }, result: { user: updated, created: false } };
      }
      const user = userSchema.parse({
        id: randomUUID(),
        issuer: input.issuer,
        subject: input.subject,
        email: input.email,
        name: input.name,
        createdAt: this.now().toISOString(),
      });
      return { snapshot: { ...snapshot, users: [...snapshot.users, user] }, result: { user, created: true } };
    });
  }

  async createMembership(input: { userId: string; orgId: string; role: Role }): Promise<Membership> {
    return this.guardedWrite((snapshot) => {
      if (!snapshot.users.some((user) => user.id === input.userId)) {
        throw new IdentityStoreError('user-not-found', `no user ${input.userId}`);
      }
      if (!snapshot.orgs.some((org) => org.id === input.orgId)) {
        throw new IdentityStoreError('org-not-found', `no org ${input.orgId}`);
      }
      if (snapshot.memberships.some((m) => m.userId === input.userId && m.orgId === input.orgId)) {
        throw new IdentityStoreError('membership-exists', `user ${input.userId} is already a member of org ${input.orgId}`);
      }
      const membership = membershipSchema.parse({ userId: input.userId, orgId: input.orgId, role: input.role });
      return { snapshot: { ...snapshot, memberships: [...snapshot.memberships, membership] }, result: membership };
    });
  }

  /**
   * D8 step 1's structural half: "the first user to sign in becomes owner of a new org;
   * subsequent users need an invite." This is the ONE place that fact is enforced, and it is
   * enforced the same way every other uniqueness constraint in this class is (D7): as a check
   * performed on the snapshot `guardedWrite` re-reads FRESH, under the lease — never a check the
   * caller performs first and then acts on, which is exactly the shape that loses a race (read
   * "no org exists" — yield to the event loop for an await — write; two callers can both read
   * "no org" before either writes).
   *
   * **What "first" means here, precisely, and why `orgs.length > 0` is the whole test.** D4: "Until
   * the per-org split ships … hosted means single-org." This method is the bootstrap for THAT
   * single org, not a general ceiling on how many `Org` rows can ever exist — `createOrg` above
   * remains available uncontested (tests use it to set up multiple orgs today; a future phase-6
   * multi-org tool would use it too). What must never happen twice is THIS structural event: a
   * user landing on a truly empty deployment and walking away as its owner. So the guard is simply
   * "has ANY org ever been bootstrapped or otherwise created" — the moment one exists, every
   * subsequent caller (a genuinely later user, or the loser of a simultaneous race) gets
   * `org-already-bootstrapped` and must go through an invite instead, exactly as D8 describes.
   * Because that check is `orgs.length > 0`, a slug collision on the org being created is provably
   * unreachable (no existing org has any slug when the write is allowed to proceed at all), so —
   * unlike `createOrg` — there is deliberately no separate `org-slug-taken` check to duplicate.
   *
   * **`role` is not a parameter.** The membership this creates is hardcoded to `'owner'`, never
   * read from the caller — the same reasoning `oidc.ts`'s module doc comment gives for why
   * `CEZ_OIDC_GROUP_ROLE_MAP` can only ever produce `'admin'`/`'member'`: "owner is not a fact
   * re-derived from an IdP claim on every login" or, here, from whatever a caller happens to pass —
   * it is a one-time structural fact about being first, decided by this method alone.
   *
   * `userId` must already name a real `User` row (`findOrCreateUser` is the caller's job, same
   * split `createMembership` already draws) — this only ever runs for an authenticated, already
   * signed-in user with a resolvable session and no membership yet.
   */
  async bootstrapFirstOrg(
    input: { userId: string; name: string; slug: string; defaultTeamName?: string; defaultTeamSlug?: string },
    ids: { orgId?: string; defaultTeamId?: string } = {},
  ): Promise<{ org: Org; defaultTeam: Team; membership: Membership }> {
    return this.guardedWrite((snapshot) => {
      if (snapshot.orgs.length > 0) {
        throw new IdentityStoreError(
          'org-already-bootstrapped',
          'an org already exists — the single-org bootstrap window is closed; new members need an invite',
        );
      }
      if (!snapshot.users.some((user) => user.id === input.userId)) {
        throw new IdentityStoreError('user-not-found', `no user ${input.userId}`);
      }
      const org = orgSchema.parse({
        id: ids.orgId ?? randomUUID(),
        name: input.name,
        slug: input.slug,
        createdAt: this.now().toISOString(),
      });
      const team = teamSchema.parse({
        id: ids.defaultTeamId ?? randomUUID(),
        orgId: org.id,
        name: input.defaultTeamName ?? 'General',
        slug: input.defaultTeamSlug ?? 'general',
      });
      const membership = membershipSchema.parse({ userId: input.userId, orgId: org.id, role: 'owner' });
      return {
        snapshot: {
          ...snapshot,
          orgs: [...snapshot.orgs, org],
          teams: [...snapshot.teams, team],
          memberships: [...snapshot.memberships, membership],
        },
        result: { org, defaultTeam: team, membership },
      };
    });
  }

  /**
   * D4's hard constraint: "a project root may belong to exactly one org … `RunStore` has no
   * lease, [so two processes over one `.ai/cezar`] is silent history loss, not a leak." The
   * `realpathSync.native` below is what makes that constraint mean something — a bare string PK
   * would let a symlink and its target register as two different roots, each innocently believing
   * it alone owns that `.ai/cezar`. This is the ONE place identity-store resolves a project root;
   * readers (`getProjectTeam`, `listProjectTeams`) take an already-normalized root by contract
   * rather than re-resolving (and risking an `ENOENT` on a root a caller is merely filtering by,
   * not touching).
   *
   * **`.native`, not plain `realpathSync` (2026-08-07, repair stage).** Node's JS-implemented
   * `fs.realpathSync` resolves symlinks and `.`/`..` but does NOT correct a wrong-case query
   * against an existing directory entry on a case-insensitive-but-case-preserving filesystem
   * (APFS/HFS+/NTFS) — it echoes back the case it was given. `.native` delegates to the OS's
   * `realpath(3)` and returns the on-disk spelling, which is the same value
   * `workspace/projects.ts#normalizeRoot` produces (that one via `fs/promises.realpath`, which is
   * libuv-backed and canonicalizes case too). Matching them matters because this PRIMARY KEY is
   * the whole of D4's one-root-one-org guarantee: with the plain version a caller who hands this
   * method `/repo/foo` while the registry holds `/repo/Foo` would mint a SECOND claim on one
   * `.ai/cezar`, which is precisely the silent run-history loss D4 exists to prevent.
   */
  async createProjectTeam(input: { projectRoot: string; orgId: string; teamId: string }): Promise<ProjectTeam> {
    const projectRoot = realpathSync.native(input.projectRoot);
    return this.guardedWrite((snapshot) => {
      if (!snapshot.orgs.some((org) => org.id === input.orgId)) {
        throw new IdentityStoreError('org-not-found', `no org ${input.orgId}`);
      }
      const team = snapshot.teams.find((t) => t.id === input.teamId);
      if (!team) throw new IdentityStoreError('team-not-found', `no team ${input.teamId}`);
      if (team.orgId !== input.orgId) {
        throw new IdentityStoreError('team-org-mismatch', `team ${input.teamId} belongs to org ${team.orgId}, not ${input.orgId}`);
      }
      if (snapshot.projectTeams.some((row) => row.projectRoot === projectRoot)) {
        throw new IdentityStoreError('project-root-taken', `project root ${projectRoot} is already assigned to an org`);
      }
      const projectTeam = projectTeamSchema.parse({ projectRoot, orgId: input.orgId, teamId: input.teamId });
      return { snapshot: { ...snapshot, projectTeams: [...snapshot.projectTeams, projectTeam] }, result: projectTeam };
    });
  }

  /**
   * Release a root's claim (ADDED 2026-08-07, repair stage). Idempotent, mirroring
   * `deleteSession`: releasing an unclaimed root is not an error, it returns `false`.
   *
   * **Why this has to exist at all.** Phase 5 enforced D4's one-root-one-org mapping on `create`
   * and on nothing else, so `DELETE /api/v1/projects/:id` unregistered the workspace entry and
   * left the `project_teams` row behind. Two consequences, both reproduced at review: the table
   * grows a row per removed project forever, and re-registering the same root afterwards silently
   * inherits the OLD team — an explicit `teamId` on the re-registration is validated and then
   * discarded, because `server.ts` prefers an existing claim over the caller's choice (correctly:
   * that is what makes the constraint a constraint). The claim must therefore be released by the
   * same request that unregisters the root.
   *
   * Takes an already-normalized root, like `getProjectTeam`/`listProjectTeams` and unlike
   * `createProjectTeam` — a root being *removed* may no longer exist on disk, and `realpathSync`
   * on it would throw `ENOENT` and turn a successful unregistration into a 500.
   */
  async deleteProjectTeam(projectRoot: string): Promise<boolean> {
    return this.guardedWrite((snapshot) => {
      const projectTeams = snapshot.projectTeams.filter((row) => row.projectRoot !== projectRoot);
      return { snapshot: { ...snapshot, projectTeams }, result: projectTeams.length !== snapshot.projectTeams.length };
    });
  }

  /** `id` is REQUIRED and caller-supplied — see `sessionSchema`'s doc comment on why the store
   *  never mints session ids itself. A collision is treated as a bug in the caller's randomness,
   *  not a retryable condition, so it throws rather than silently overwriting someone's session. */
  async createSession(input: { id: string; userId: string; expiresAt: Date }): Promise<Session> {
    return this.guardedWrite((snapshot) => {
      if (!snapshot.users.some((user) => user.id === input.userId)) {
        throw new IdentityStoreError('user-not-found', `no user ${input.userId}`);
      }
      if (snapshot.sessions.some((s) => s.id === input.id)) {
        throw new IdentityStoreError('session-id-taken', `session id ${input.id} already exists`);
      }
      const now = this.now();
      // Opportunistic prune on every session write, mirroring `AutomationStore`'s tombstone
      // pruning on every definitions write — sessions accumulate on every sign-in and nothing else
      // ever visits every row, so "prune when we're already holding the lease and writing anyway"
      // is the only hook that reliably runs.
      const pruned = snapshot.sessions.filter((s) => Date.parse(s.expiresAt) > now.getTime());
      const session = sessionSchema.parse({
        id: input.id,
        userId: input.userId,
        expiresAt: input.expiresAt.toISOString(),
        createdAt: now.toISOString(),
      });
      return { snapshot: { ...snapshot, sessions: [...pruned, session] }, result: session };
    });
  }

  /** Logout. Idempotent — deleting an already-gone/expired session is not an error, it returns
   *  `false` rather than throwing. */
  async deleteSession(id: string): Promise<boolean> {
    return this.guardedWrite((snapshot) => {
      const sessions = snapshot.sessions.filter((s) => s.id !== id);
      return { snapshot: { ...snapshot, sessions }, result: sessions.length !== snapshot.sessions.length };
    });
  }

  // ---- invites: implemented by the "memberships + invites" unit ---------------------------------
  //
  // D8: "subsequent users need an invite." Every method below has the exact shape every OTHER
  // write method in this class already has — one `guardedWrite` call, checks-then-insert inside
  // its callback, nothing touching the lease or the file directly — filled in exactly per the
  // guarded-write contract each doc comment below states; see `identity-store.test.ts`'s "invites"
  // describe block for the coverage proving each check and the redeem-is-atomic claim.

  /**
   * `id` is REQUIRED and caller-supplied, mirroring `createSession` above and for the identical
   * reason (`sessionSchema`'s own doc comment): the store never mints the bearer token itself —
   * that randomness policy belongs to whichever module calls this, not to the store.
   *
   * Checks the implementation must perform, inside the SAME guarded write (`guardedWrite` re-reads
   * the snapshot fresh under the lease — these must run against THAT read, never a value captured
   * before the lease was acquired):
   *  - `org-not-found` if `input.orgId` names no org.
   *  - if `input.teamId` is present: `team-not-found` if it names no team, `team-org-mismatch` if
   *    that team belongs to a different org than `input.orgId` — the exact two checks
   *    `createProjectTeam` below already performs, for the same reason.
   *  - `invite-id-taken` if `input.id` already exists in `invites` (mirrors `session-id-taken`).
   */
  async createInvite(input: {
    id: string;
    orgId: string;
    teamId?: string;
    role: Role;
    expiresAt: Date;
  }): Promise<Invite> {
    return this.guardedWrite((snapshot) => {
      if (!snapshot.orgs.some((org) => org.id === input.orgId)) {
        throw new IdentityStoreError('org-not-found', `no org ${input.orgId}`);
      }
      if (input.teamId !== undefined) {
        const team = snapshot.teams.find((t) => t.id === input.teamId);
        if (!team) throw new IdentityStoreError('team-not-found', `no team ${input.teamId}`);
        if (team.orgId !== input.orgId) {
          throw new IdentityStoreError('team-org-mismatch', `team ${input.teamId} belongs to org ${team.orgId}, not ${input.orgId}`);
        }
      }
      if (snapshot.invites.some((invite) => invite.id === input.id)) {
        throw new IdentityStoreError('invite-id-taken', `invite id ${input.id} already exists`);
      }
      const invite = inviteSchema.parse({
        id: input.id,
        orgId: input.orgId,
        teamId: input.teamId,
        role: input.role,
        createdAt: this.now().toISOString(),
        expiresAt: input.expiresAt.toISOString(),
      });
      return { snapshot: { ...snapshot, invites: [...snapshot.invites, invite] }, result: invite };
    });
  }

  /**
   * Redeeming an invite and granting the resulting membership MUST be one guarded write, not two
   * — the exact atomicity `createOrg` already applies to "org + its default team", for the same
   * reason: two separate writes would each be individually consistent but leave a window, if the
   * process died between them, where an invite reads as consumed with no membership to show for
   * it. Fold both mutations into one `guardedWrite` call.
   *
   * Checks, in order, inside that one guarded write:
   *  - `invite-not-found` if no invite with `input.id` exists at all.
   *  - `invite-already-consumed` if it exists but `consumedAt` is already set.
   *  - `invite-expired` if `expiresAt` has passed (do NOT reuse `getInvite` for this check —
   *    that method already folds "consumed" and "expired" into one `undefined`, which cannot
   *    distinguish the three error codes this method must raise separately; read `invites`
   *    off the fresh snapshot directly, the same way every other checker in this class does).
   *  - `user-not-found` if `input.userId` names no user.
   *  - `membership-exists` if that user already has a membership in the invite's `orgId` (reuse
   *    `createMembership`'s own check — an already-a-member redeeming a second invite to the same
   *    org is not a new grant).
   *
   * On success: stamp `consumedAt`/`consumedByUserId` on the invite row AND insert the new
   * `Membership` row (role from `invite.role`), both in the returned `snapshot`.
   */
  async redeemInvite(input: { id: string; userId: string }): Promise<{ invite: Invite; membership: Membership }> {
    return this.guardedWrite((snapshot) => {
      const index = snapshot.invites.findIndex((invite) => invite.id === input.id);
      const existing = snapshot.invites[index];
      if (!existing) throw new IdentityStoreError('invite-not-found', `no invite ${input.id}`);
      if (existing.consumedAt) throw new IdentityStoreError('invite-already-consumed', `invite ${input.id} was already consumed`);
      if (Date.parse(existing.expiresAt) <= this.now().getTime()) {
        throw new IdentityStoreError('invite-expired', `invite ${input.id} expired at ${existing.expiresAt}`);
      }
      if (!snapshot.users.some((user) => user.id === input.userId)) {
        throw new IdentityStoreError('user-not-found', `no user ${input.userId}`);
      }
      if (snapshot.memberships.some((m) => m.userId === input.userId && m.orgId === existing.orgId)) {
        throw new IdentityStoreError('membership-exists', `user ${input.userId} is already a member of org ${existing.orgId}`);
      }
      const consumedInvite = inviteSchema.parse({
        ...existing,
        consumedAt: this.now().toISOString(),
        consumedByUserId: input.userId,
      });
      const membership = membershipSchema.parse({ userId: input.userId, orgId: existing.orgId, role: existing.role });
      const invites = [...snapshot.invites];
      invites[index] = consumedInvite;
      return {
        snapshot: { ...snapshot, invites, memberships: [...snapshot.memberships, membership] },
        result: { invite: consumedInvite, membership },
      };
    });
  }

  /** Revoke an invite before it is redeemed. Idempotent, mirroring `deleteSession` above: revoking
   *  an already-gone, already-expired or already-consumed invite is not an error, it returns
   *  `false` rather than throwing — the caller asked for the invite to not be usable, and it
   *  already isn't. */
  async revokeInvite(id: string): Promise<boolean> {
    return this.guardedWrite((snapshot) => {
      const existing = snapshot.invites.find((invite) => invite.id === id);
      const isActive = existing !== undefined && !existing.consumedAt && Date.parse(existing.expiresAt) > this.now().getTime();
      if (!isActive) {
        // Idempotent no-op — and deliberately NOT a delete for a missing/consumed/expired row:
        // `listOrgInvites`'s own doc comment says consumed/expired rows are kept for an admin
        // "invite history" view to filter, and revoking an already-consumed invite must not erase
        // who redeemed it (`consumedByUserId`/`consumedAt`).
        return { snapshot, result: false };
      }
      const invites = snapshot.invites.filter((invite) => invite.id !== id);
      return { snapshot: { ...snapshot, invites }, result: true };
    });
  }

  // ---- lease + transaction plumbing --------------------------------------------------------------

  /**
   * One non-blocking attempt at the write lease — the same "open `wx`, stale-reclaim, else
   * undefined" idiom as `SourceStore.acquireLease`/`AutomationStore.acquireLease`. Exposed
   * publicly (unlike those, which only ever poll internally) because it doubles as the test seam
   * for proving the guarded writers below actually wait on a lease someone else holds, rather than
   * the single-threaded-JS accident that would make "two writes don't corrupt each other" trivially
   * true here and prove nothing about the lease itself.
   */
  acquireLease(staleAfterMs = this.staleLeaseMs): IdentityLease | undefined {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, LOCK_FILE);
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: this.now().toISOString() }));
      return new IdentityLease(path, fd);
    } catch {
      try {
        if (this.now().getTime() - statSync(path).mtimeMs > staleAfterMs) {
          unlinkSync(path);
          return this.acquireLease(staleAfterMs);
        }
      } catch {
        // A contender released it, or the directory is read-only.
      }
      return undefined;
    }
  }

  /** Retries `acquireLease` with bounded exponential backoff until it succeeds or
   *  `lockTimeoutMs` elapses — the "retry and block" half described in this class's module doc.
   *  Throws `lease-timeout` rather than returning `undefined`, because every write here is a
   *  user-facing action with no caller that would know what "skip this write" means. */
  private async acquireLeaseBlocking(): Promise<IdentityLease> {
    const deadline = Date.now() + this.lockTimeoutMs;
    let delay = this.lockRetryMs;
    for (;;) {
      const lease = this.acquireLease();
      if (lease) return lease;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new IdentityStoreError(
          'lease-timeout',
          `identity store write lease stayed held for over ${this.lockTimeoutMs}ms — another writer may be stuck`,
        );
      }
      await sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
    }
  }

  /**
   * The one guarded helper D7 asks for: takes the lease, reads the snapshot FRESH off disk (never
   * the caller's or this instance's stale idea of it — there is no cached idea to be stale, see the
   * class doc), hands it to `mutate` for its own checks-then-insert, writes the result back
   * atomically, and always releases. Every public write method above is a thin wrapper around one
   * call to this; none of them touch the lease or the file directly.
   */
  private async guardedWrite<T>(mutate: (snapshot: IdentitySnapshot) => { snapshot: IdentitySnapshot; result: T }): Promise<T> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lease = await this.acquireLeaseBlocking();
    try {
      const current = this.readSnapshot();
      const { snapshot, result } = mutate(current);
      this.writeSnapshot(snapshot);
      return result;
    } finally {
      lease.release();
    }
  }

  // ---- on-disk shape ------------------------------------------------------------------------------

  /** Never creates the directory or the file — a read must not materialize state (AGENTS.md "Zero
   *  config": "new state may be WRITTEN, never REQUIRED"), and D7 asks specifically that
   *  `identity.json` is "created lazily on first authenticated boot". Missing file degrades to
   *  `emptyIdentitySnapshot()` silently (the normal, expected case for every boot before the first
   *  write); a present-but-corrupt file degrades the same way with one warning, never a throw,
   *  matching every other store's read path in this codebase. */
  private readSnapshot(): IdentitySnapshot {
    const path = join(this.dir, SNAPSHOT_FILE);
    if (!existsSync(path)) return emptyIdentitySnapshot();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      this.warnOnce('parse', `Ignored a corrupt ${SNAPSHOT_FILE} — identity reads as empty until the next successful write.`);
      return emptyIdentitySnapshot();
    }
    if (typeof raw !== 'object' || raw === null) {
      this.warnOnce('parse', `Ignored a malformed ${SNAPSHOT_FILE} (not an object) — identity reads as empty until the next successful write.`);
      return emptyIdentitySnapshot();
    }
    const obj = raw as Record<string, unknown>;
    // Any top-level key this version doesn't recognize rides along untouched — the same
    // `.passthrough()` contract every row schema below gets, applied by hand here because the
    // known keys are rebuilt individually (per-entry salvage, not `identitySnapshotSchema.parse`
    // wholesale) rather than round-tripped as-is.
    const KNOWN_KEYS = new Set([
      'version',
      'orgs',
      'teams',
      'users',
      'memberships',
      'projectTeams',
      'sessions',
      'invites',
    ]);
    const passthroughTop: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!KNOWN_KEYS.has(key)) passthroughTop[key] = value;
    }
    // Per-entry salvage, per table — matching `SourceStore`'s "one bad row must not evict its
    // siblings" discipline (BACKWARD_COMPATIBILITY.md §3/§9). A corrupt `users` row must not also
    // erase every `org` in the same file.
    return {
      ...passthroughTop,
      version: 1,
      orgs: this.salvage(obj.orgs, orgSchema, 'orgs'),
      teams: this.salvage(obj.teams, teamSchema, 'teams'),
      users: this.salvage(obj.users, userSchema, 'users'),
      memberships: this.salvage(obj.memberships, membershipSchema, 'memberships'),
      projectTeams: this.salvage(obj.projectTeams, projectTeamSchema, 'projectTeams'),
      sessions: this.salvage(obj.sessions, sessionSchema, 'sessions'),
      // A file written before this scaffold added `invites` (i.e. every identity.json on disk
      // today) simply has no `invites` key — `obj.invites` is `undefined`, and `salvage` already
      // treats a non-array as "no rows" rather than throwing, so this reads as `[]` exactly like
      // `emptyIdentitySnapshot()`'s own default. No migration needed (D7/AGENTS.md: new fields are
      // additive, never required of an old file).
      invites: this.salvage(obj.invites, inviteSchema, 'invites'),
    };
  }

  private salvage<T>(value: unknown, schema: { safeParse(v: unknown): { success: boolean; data?: T } }, label: string): T[] {
    if (!Array.isArray(value)) return [];
    const rows: T[] = [];
    let dropped = 0;
    for (const row of value) {
      const parsed = schema.safeParse(row);
      if (parsed.success && parsed.data !== undefined) rows.push(parsed.data);
      else dropped += 1;
    }
    if (dropped > 0) this.warnOnce(label, `Skipped ${dropped} malformed "${label}" row(s) in ${SNAPSHOT_FILE}.`);
    return rows;
  }

  /** `identitySnapshotSchema.parse` (not `safeParse`) here is a deliberate internal assertion: by
   *  the time a snapshot reaches this method it was built by one of this class's own `mutate`
   *  callbacks from already-validated rows, so a failure here means a bug in THIS file, not bad
   *  external input — and it should throw loudly rather than silently write a shape the schema
   *  itself would reject on the next read. */
  private writeSnapshot(snapshot: IdentitySnapshot): void {
    const validated = identitySnapshotSchema.parse(snapshot);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, SNAPSHOT_FILE);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    try {
      // Best-effort defensive re-assert of the mode post-rename — `workspace/config.ts` does the
      // same for the same reason: `writeFileSync`'s `mode` option is only reliable net of umask
      // when the file is newly created, and this file holds session/auth data.
      chmodSync(path, 0o600);
    } catch {
      // Ignored on filesystems that don't support it.
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.options.warn?.(message);
  }
}
