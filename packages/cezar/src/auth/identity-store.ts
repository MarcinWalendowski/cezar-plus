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

/**
 * D13: the local user's fixed `(issuer, subject)` identity key — never a nullable-issuer bypass.
 * `findOrCreateUser` keys every row on `(issuer, subject)`, both required (`userSchema`'s own doc
 * comment: "identity is (issuer, sub), never email"); a local, IdP-less deployment gets a REAL row
 * with these two literals instead of a schema change that would let `issuer` go missing for
 * everyone. `'local'` is not a URL, so it can never collide with a real OIDC issuer (those are
 * always absolute URLs per D9's discovery flow) — which is exactly what makes "this deployment
 * later turns auth on" well-defined: the local row and any future OIDC row for the same human stay
 * two different rows (merging them is out of scope, D13's own Risks). Exported so
 * `auth/local-identity.ts`'s resolver can look the row back up by the same key without either file
 * duplicating the literal.
 */
export const LOCAL_USER_ISSUER = 'local';
export const LOCAL_USER_SUBJECT = 'local';

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
  // ---- F4's first-membership pinning, enforced rather than silently produced (ADDED 2026-08-07,
  // 5b/5c/8 repair stage). `session.ts#resolveIdentity` resolves a signed-in user as
  // `listMemberships(userId)[0]` — the OLDEST membership — and there is no active-org switcher, so
  // a SECOND membership is inert: every request that user ever makes still resolves against their
  // first org. Both writes that can mint one (`claimOrg`'s D11 claim branch and `redeemInvite`)
  // therefore REFUSE a user who already belongs to an org, rather than writing a membership the
  // product cannot honour. See both methods' own doc comments for the two concrete failures this
  // closes — a burnt one-shot org claim code and a burnt single-use invite, each answering 201 for
  // a grant that does nothing, neither recoverable by any route in the product. Lift this the moment
  // an active-org selector exists; until then a refusal that leaves the credential spendable is the
  // only honest answer. ----------------------------------------------------------------------------
  | 'user-already-member'
  | 'project-root-taken'
  | 'session-id-taken'
  | 'lease-timeout'
  // ---- D8 first-user bootstrap race (see `claimOrg`'s own doc comment, legacy branch) -----------
  | 'org-already-bootstrapped'
  // ---- D11 claim-an-unclaimed-org (5b/5c/8 scaffold pass — see `claimOrg`'s own doc comment,
  // claim branch; thrown when the named org already has a member) --------------------------------
  | 'org-already-claimed'
  // ---- invites (scaffold addition — see `types.ts`'s `inviteSchema` doc comment) --------------
  | 'invite-id-taken'
  | 'invite-not-found'
  | 'invite-expired'
  | 'invite-already-consumed'
  // ---- 5c team management: project→team reassignment (scaffold addition — see
  // `updateProjectTeam`'s own doc comment; NOT thrown by any method in this file today, declared
  // here so Fill unit 3 doesn't have to invent the spelling) --------------------------------------
  | 'project-root-not-found'
  // ---- 5c team management: deleteTeam (ADDED this pass, Fill unit 3 — see `deleteTeam`'s own doc
  // comment for the refuse-vs-reassign decision this code is the answer to) -----------------------
  | 'team-has-projects'
  // ---- 5c team management: deleting an org's LAST team (ADDED 2026-08-07, 5b/5c/8 repair stage —
  // see `deleteTeam`'s own doc comment; a team-less org resolves NO principal for ANY of its
  // members, which is a permanent, in-product-unrecoverable lockout) ------------------------------
  | 'team-is-last';

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
    return this.readSnapshot().teams.find(
      (team) => team.orgId === orgId && team.slug === slug,
    );
  }

  getUserById(id: string): User | undefined {
    return this.readSnapshot().users.find((user) => user.id === id);
  }

  /** The only user lookup that matters for sign-in — see `types.ts`'s `userSchema` doc for why
   *  this, and never email, is the identity key. */
  getUserByIssuerSubject(issuer: string, subject: string): User | undefined {
    return this.readSnapshot().users.find(
      (user) => user.issuer === issuer && user.subject === subject,
    );
  }

  listMemberships(userId: string): Membership[] {
    return this.readSnapshot().memberships.filter(
      (membership) => membership.userId === userId,
    );
  }

  listOrgMembers(orgId: string): Membership[] {
    return this.readSnapshot().memberships.filter(
      (membership) => membership.orgId === orgId,
    );
  }

  getMembership(userId: string, orgId: string): Membership | undefined {
    return this.readSnapshot().memberships.find(
      (membership) =>
        membership.userId === userId && membership.orgId === orgId,
    );
  }

  /** Filters are ANDed. Callers registering/looking up a specific root are expected to pass an
   *  already-`realpath`d value — see `createProjectTeam`'s own comment for why normalization is
   *  centralized at the one write site rather than repeated (and possibly forgotten) in every
   *  reader. */
  listProjectTeams(
    filter: { orgId?: string; teamId?: string } = {},
  ): ProjectTeam[] {
    return this.readSnapshot().projectTeams.filter(
      (row) =>
        (filter.orgId === undefined || row.orgId === filter.orgId) &&
        (filter.teamId === undefined || row.teamId === filter.teamId),
    );
  }

  getProjectTeam(projectRoot: string): ProjectTeam | undefined {
    return this.readSnapshot().projectTeams.find(
      (row) => row.projectRoot === projectRoot,
    );
  }

  /** Expired sessions read as absent — never returns a row whose `expiresAt` has passed, so no
   *  caller (there will be exactly one today, `../auth/session.ts`, but the guarantee is meant to
   *  outlive that) can forget to re-check it, the same centralization principle D7 asks for around
   *  uniqueness applied to expiry. */
  getSession(id: string): Session | undefined {
    const session = this.readSnapshot().sessions.find((row) => row.id === id);
    if (!session) return undefined;
    return Date.parse(session.expiresAt) > this.now().getTime()
      ? session
      : undefined;
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
    return Date.parse(invite.expiresAt) > this.now().getTime()
      ? invite
      : undefined;
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
   *
   * **`input.claimTokenHash` (ADDED 2026-08-07, 5b/5c/8 scaffold pass, D11).** Optional, and this
   * method does no hashing itself — the SAME "the store never invents the credential, it only
   * persists what it is given" idiom `createSession`/`createInvite` already follow for their own
   * bearer tokens. The intended caller is `POST /internal/orgs` (Fill unit 6): mint a raw code with
   * `./org-claim-token.ts#mintOrgClaimToken`, hash it with `#hashOrgClaimToken`, pass the HASH here,
   * and return the raw code to the installer once in that route's own response — never round-tripped
   * through this store. Absent (every existing caller, including every test) leaves
   * `Org.claimTokenHash` unset, exactly as before this field existed.
   */
  async createOrg(
    input: {
      name: string;
      slug: string;
      defaultTeamName?: string;
      defaultTeamSlug?: string;
      claimTokenHash?: string;
    },
    ids: { orgId?: string; defaultTeamId?: string } = {},
  ): Promise<{ org: Org; defaultTeam: Team }> {
    return this.guardedWrite((snapshot) => {
      if (snapshot.orgs.some((org) => org.slug === input.slug)) {
        throw new IdentityStoreError(
          'org-slug-taken',
          `an org with slug "${input.slug}" already exists`,
        );
      }
      const org = orgSchema.parse({
        id: ids.orgId ?? randomUUID(),
        name: input.name,
        slug: input.slug,
        createdAt: this.now().toISOString(),
        claimTokenHash: input.claimTokenHash,
      });
      const team = teamSchema.parse({
        id: ids.defaultTeamId ?? randomUUID(),
        orgId: org.id,
        name: input.defaultTeamName ?? 'General',
        slug: input.defaultTeamSlug ?? 'general',
      });
      return {
        snapshot: {
          ...snapshot,
          orgs: [...snapshot.orgs, org],
          teams: [...snapshot.teams, team],
        },
        result: { org, defaultTeam: team },
      };
    });
  }

  /** A later (non-default) team — `engineering`, `marketing` per the spec's own example — added to
   *  an org that already exists. */
  async createTeam(
    input: { orgId: string; name: string; slug: string },
    id?: string,
  ): Promise<Team> {
    return this.guardedWrite((snapshot) => {
      if (!snapshot.orgs.some((org) => org.id === input.orgId)) {
        throw new IdentityStoreError('org-not-found', `no org ${input.orgId}`);
      }
      if (
        snapshot.teams.some(
          (team) => team.orgId === input.orgId && team.slug === input.slug,
        )
      ) {
        throw new IdentityStoreError(
          'team-slug-taken',
          `org ${input.orgId} already has a team with slug "${input.slug}"`,
        );
      }
      const team = teamSchema.parse({
        id: id ?? randomUUID(),
        orgId: input.orgId,
        name: input.name,
        slug: input.slug,
      });
      return {
        snapshot: { ...snapshot, teams: [...snapshot.teams, team] },
        result: team,
      };
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
      if (!existing)
        throw new IdentityStoreError('team-not-found', `no team ${id}`);
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
      const index = snapshot.users.findIndex(
        (user) =>
          user.issuer === input.issuer && user.subject === input.subject,
      );
      const existing = snapshot.users[index];
      if (existing) {
        const updated = userSchema.parse({
          ...existing,
          email: input.email ?? existing.email,
          name: input.name ?? existing.name,
        });
        const users = [...snapshot.users];
        users[index] = updated;
        return {
          snapshot: { ...snapshot, users },
          result: { user: updated, created: false },
        };
      }
      const user = userSchema.parse({
        id: randomUUID(),
        issuer: input.issuer,
        subject: input.subject,
        email: input.email,
        name: input.name,
        createdAt: this.now().toISOString(),
      });
      return {
        snapshot: { ...snapshot, users: [...snapshot.users, user] },
        result: { user, created: true },
      };
    });
  }

  /**
   * D13: the local user, without an IdP. A thin, named wrapper over `findOrCreateUser` above —
   * NOT a second write path — reusing that method's guarded write and its lease is what "the local
   * user is `issuer: 'local', subject: 'local'`, which keeps the `(issuer, subject)` key honest"
   * (D13's own text) means concretely: this method invents no new uniqueness rule, no new schema
   * branch and no nullable-issuer bypass, it just spells `LOCAL_USER_ISSUER`/`LOCAL_USER_SUBJECT`
   * once so `auth/local-identity.ts`'s onboarding write (and any other future local-mode caller)
   * never has to. Idempotent for the same reason `findOrCreateUser` already is: calling this twice
   * (e.g. a re-run of the onboarding wizard against an already-onboarded `CEZ_HOME`) returns the
   * SAME row, `created: false` the second time, never a duplicate.
   */
  async findOrCreateLocalUser(): Promise<{ user: User; created: boolean }> {
    return this.findOrCreateUser({
      issuer: LOCAL_USER_ISSUER,
      subject: LOCAL_USER_SUBJECT,
    });
  }

  async createMembership(input: {
    userId: string;
    orgId: string;
    role: Role;
  }): Promise<Membership> {
    return this.guardedWrite((snapshot) => {
      if (!snapshot.users.some((user) => user.id === input.userId)) {
        throw new IdentityStoreError(
          'user-not-found',
          `no user ${input.userId}`,
        );
      }
      if (!snapshot.orgs.some((org) => org.id === input.orgId)) {
        throw new IdentityStoreError('org-not-found', `no org ${input.orgId}`);
      }
      if (
        snapshot.memberships.some(
          (m) => m.userId === input.userId && m.orgId === input.orgId,
        )
      ) {
        throw new IdentityStoreError(
          'membership-exists',
          `user ${input.userId} is already a member of org ${input.orgId}`,
        );
      }
      const membership = membershipSchema.parse({
        userId: input.userId,
        orgId: input.orgId,
        role: input.role,
      });
      return {
        snapshot: {
          ...snapshot,
          memberships: [...snapshot.memberships, membership],
        },
        result: membership,
      };
    });
  }

  /**
   * **RENAMED from `bootstrapFirstOrg` (D11, 5b/5c/8 scaffold pass → Fill unit 7, landed
   * 2026-08-07).** D11: "a function called `bootstrapFirstOrg` that no longer creates anything is
   * exactly the stale name a future session would trust" — and this method now sometimes doesn't
   * create anything, so "claim" is the honest verb: become an org's owner, whether that org is
   * minted by this same call (legacy) or already exists (D11).
   *
   * D8 step 1's structural half — "the first user to sign in becomes owner of a new org;
   * subsequent users need an invite" — plus D11's extension of it to the SECOND and later org, now
   * live in one method with two branches, forked on whether `input.orgId` is present. Both branches
   * share the same discipline every other uniqueness constraint in this class uses (D7): the check
   * runs on the snapshot `guardedWrite` re-reads FRESH, under the lease — never a check the caller
   * performs first and then acts on, which is exactly the shape that loses a race (read "no org
   * exists" — yield to the event loop for an await — write; two callers can both read "no org"
   * before either writes).
   *
   * **`orgId` ABSENT — the legacy path, UNCHANGED, byte-for-byte from `bootstrapFirstOrg`.** Every
   * existing caller (today: `onboarding-routes.ts`'s `POST /auth/onboarding/org` with no `orgSlug`
   * in its body) keeps working exactly as before: guard `snapshot.orgs.length > 0` →
   * `org-already-bootstrapped`, create org+team+`owner`-membership from `input.name`/`input.slug`
   * in one write. This is what a bare `cezar serve --auth oidc` (no supervisor, D1's own "loopback
   * + oidc: useful for testing the flow" row) still needs — it has no `/internal/orgs` route to
   * pre-create anything with, so self-serve creation of the deployment's first org must keep
   * working. **D11's "creating an organization requires root" is about a SECOND org behind a
   * supervisor, never about this path.**
   *
   * What "first" means here, precisely, and why `orgs.length > 0` is the whole test in this branch:
   * D4 said "until the per-org split ships … hosted means single-org", and this branch is the
   * bootstrap for THAT single org, not a general ceiling on how many `Org` rows can ever exist —
   * `createOrg` remains available uncontested (D11's `POST /internal/orgs` uses it to mint org two
   * and later). What must never happen twice is THIS structural event: a user landing on a truly
   * empty deployment and walking away as its owner. Because the check is `orgs.length > 0`, a slug
   * collision on the org being created is provably unreachable (no existing org has any slug when
   * the write is allowed to proceed at all) — unlike `createOrg`, there is deliberately no separate
   * `org-slug-taken` check to duplicate.
   *
   * **`orgId` PRESENT — the D11 claim path, new.** The org (and its default team) already exist,
   * created by the admin-only `POST /internal/orgs` (Fill unit 6, `createOrg`'s `claimTokenHash`
   * input). Checks, in this order, inside the SAME guarded write: `org-not-found` if no org has
   * that id; `org-already-claimed` if `snapshot.memberships.some(m => m.orgId === org.id)` — i.e.
   * this org already has at least one member, which can only be its owner, since nothing can
   * redeem an invite before an owner exists to send one; `user-not-found` for the same defensive
   * reason the legacy branch checks it; and — ADDED 2026-08-07 at the 5b/5c/8 repair stage —
   * `user-already-member` if the CALLER already belongs to any org (see the check's own comment
   * below for the operator-bricks-org-two failure that closes, and `IdentityStoreErrorCode`'s
   * `user-already-member` note for why F4 makes a second membership inert in the first place).
   * Then look up the org's EXISTING default team
   * (`snapshot.teams.find(t => t.orgId === org.id)` — never create a second one) and insert just
   * the `owner` `Membership`. `input.name`/`input.slug` have no meaning in this branch — the org
   * already has both, which is exactly why the two branches are two members of a union rather than
   * one object with every field optional: a caller claiming an existing org has nothing to name.
   *
   * **`role` is not a parameter, in either branch.** The membership created here is hardcoded to
   * `'owner'`, never read from the caller — the same reasoning `oidc.ts`'s module doc comment gives
   * for why `CEZ_OIDC_GROUP_ROLE_MAP` can only ever produce `'admin'`/`'member'`: owner is not a
   * fact re-derived from an IdP claim, or from whatever a caller happens to pass — it is a
   * one-time structural fact about being first (deployment-wide or per-org), decided by this
   * method alone.
   *
   * **Bootstrap-token verification is OUT of this method, in both branches.** Exactly like the
   * legacy path (checked by the ROUTE against the single deployment-wide `./bootstrap-claim.ts`
   * code, never inside this store method), the claim path's token check belongs in the route too —
   * against `org.claimTokenHash` via `./org-claim-token.ts#matchesOrgClaimToken` — so this method
   * never receives a raw token, only a userId and (for the claim branch) an org to attach it to.
   *
   * `userId` must already name a real `User` row (`findOrCreateUser` is the caller's job, same
   * split `createMembership` already draws) — this only ever runs for an authenticated, already
   * signed-in user with a resolvable session and no membership yet.
   */
  async claimOrg(
    input:
      | {
          userId: string;
          name: string;
          slug: string;
          defaultTeamName?: string;
          defaultTeamSlug?: string;
          /**
           * **D13 project adoption.** Already-registered project roots (e.g. the boot project every
           * `cezar serve` has from its very first run) to file under this org's new default team, IN
           * THIS SAME guarded write — "an org whose project list is empty is a FAIL, not a cosmetic
           * gap" (D13's own words). Legacy-branch only: the D11 claim branch attaches an owner to an
           * org that already exists on a fresh org process, which has no already-registered projects
           * of its own to adopt.
           *
           * Every root here is trusted to already be normalized (`realpathSync.native`'d), the same
           * contract `deleteProjectTeam`/`getProjectTeam`/`listProjectTeams` already hold their
           * callers to (see `createProjectTeam`'s own doc comment for the one place that DOES
           * re-resolve) — the caller here is D13's local-org onboarding write, filing roots the
           * workspace registry already normalized at registration time, not raw user input.
           *
           * No "already claimed" check against `snapshot.projectTeams`: `createProjectTeam` requires
           * `org-not-found` to fail first, so a `project_teams` row can only exist for an org that
           * exists, and this branch's own `org-already-bootstrapped` guard just above only lets this
           * code run when `snapshot.orgs.length === 0` — no org has ever existed yet, so no
           * `project_teams` row referencing one can exist either. Duplicate roots WITHIN this list
           * are still de-duplicated below (a caller error, not a data hazard, but the PK would
           * otherwise see two rows for one root).
           */
          projectRoots?: string[];
        }
      | { userId: string; orgId: string },
    ids: { orgId?: string; defaultTeamId?: string } = {},
  ): Promise<{ org: Org; defaultTeam: Team; membership: Membership }> {
    return this.guardedWrite((snapshot) => {
      if ('orgId' in input) {
        // ---- D11 claim path: the org (and its default team) already exist ----------------------
        const org = snapshot.orgs.find(
          (candidate) => candidate.id === input.orgId,
        );
        if (!org)
          throw new IdentityStoreError(
            'org-not-found',
            `no org ${input.orgId}`,
          );
        if (snapshot.memberships.some((m) => m.orgId === org.id)) {
          throw new IdentityStoreError(
            'org-already-claimed',
            `org ${org.id} already has an owner`,
          );
        }
        if (!snapshot.users.some((user) => user.id === input.userId)) {
          throw new IdentityStoreError(
            'user-not-found',
            `no user ${input.userId}`,
          );
        }
        // ---- the caller must not already belong to an org (ADDED 2026-08-07, 5b/5c/8 repair
        // stage; see `IdentityStoreErrorCode`'s `user-already-member` note for the general rule).
        //
        // **The failure this closes, reproduced at review.** The operator who runs
        // `server-install --platform hetzner --org-slug initech` reads that org's one-shot claim
        // code off the install output — and is very often already the owner of the deployment's
        // first org. Pasting the code into their own signed-in browser (the natural way to check
        // it works) answered **201, role: owner**, wrote a second membership, and burnt the claim
        // in the same guarded write. Because `session.ts#resolveIdentity` pins to
        // `listMemberships(userId)[0]`, that membership was inert — the operator kept acting as
        // org one forever — while the new org now had a member, so `org-already-claimed` refused
        // every later claim, including the intended owner's. There is no unclaim route, no
        // member-removal route and no re-mint, so the unix user, `CEZ_HOME`, systemd unit, vhost
        // and TLS cert phases 6/7 provisioned for it were dead short of hand-editing
        // `identity.json`. A refusal costs the operator one browser profile; the 201 cost the org.
        //
        // Checked HERE, inside the guarded write, beside `org-already-claimed` rather than in the
        // route — same reasoning D7 gives for every other uniqueness check in this class: a check
        // the caller performs first and then acts on is the shape that loses a race.
        //
        // The LEGACY branch below deliberately gets no such check: it only runs when
        // `snapshot.orgs.length === 0`, and a membership must reference an org, so its caller is a
        // first-ever user by construction.
        if (snapshot.memberships.some((m) => m.userId === input.userId)) {
          throw new IdentityStoreError(
            'user-already-member',
            `user ${input.userId} already belongs to an organization on this deployment`,
          );
        }
        // The org's EXISTING default team, never a new one — `createOrg` is this org's only
        // possible producer and always creates one in the SAME write as the org itself (see its
        // own doc comment), so a missing team here would mean a bug in that method, not a case
        // this branch needs a dedicated error code for.
        const team = snapshot.teams.find((t) => t.orgId === org.id);
        if (!team)
          throw new IdentityStoreError(
            'team-not-found',
            `org ${org.id} has no default team to attach an owner to`,
          );
        const membership = membershipSchema.parse({
          userId: input.userId,
          orgId: org.id,
          role: 'owner',
        });
        return {
          snapshot: {
            ...snapshot,
            memberships: [...snapshot.memberships, membership],
          },
          result: { org, defaultTeam: team, membership },
        };
      }

      // ---- legacy path: create the deployment's first-ever org, otherwise UNCHANGED from
      // `bootstrapFirstOrg` — the one addition is `projectRoots` adoption below (D13, phase 9) ----
      if (snapshot.orgs.length > 0) {
        throw new IdentityStoreError(
          'org-already-bootstrapped',
          'an org already exists — the single-org bootstrap window is closed; new members need an invite',
        );
      }
      if (!snapshot.users.some((user) => user.id === input.userId)) {
        throw new IdentityStoreError(
          'user-not-found',
          `no user ${input.userId}`,
        );
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
      const membership = membershipSchema.parse({
        userId: input.userId,
        orgId: org.id,
        role: 'owner',
      });
      // D13 project adoption — see `projectRoots`'s own doc comment on the input type above for
      // why no "already claimed" check is needed here. `Set` dedupes a caller passing the same
      // root twice, which would otherwise mint two `project_teams` rows sharing one PK.
      const adoptedProjectTeams = [...new Set(input.projectRoots ?? [])].map((projectRoot) =>
        projectTeamSchema.parse({ projectRoot, orgId: org.id, teamId: team.id }),
      );
      return {
        snapshot: {
          ...snapshot,
          orgs: [...snapshot.orgs, org],
          teams: [...snapshot.teams, team],
          memberships: [...snapshot.memberships, membership],
          projectTeams: [...snapshot.projectTeams, ...adoptedProjectTeams],
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
  async createProjectTeam(input: {
    projectRoot: string;
    orgId: string;
    teamId: string;
  }): Promise<ProjectTeam> {
    const projectRoot = realpathSync.native(input.projectRoot);
    return this.guardedWrite((snapshot) => {
      if (!snapshot.orgs.some((org) => org.id === input.orgId)) {
        throw new IdentityStoreError('org-not-found', `no org ${input.orgId}`);
      }
      const team = snapshot.teams.find((t) => t.id === input.teamId);
      if (!team)
        throw new IdentityStoreError(
          'team-not-found',
          `no team ${input.teamId}`,
        );
      if (team.orgId !== input.orgId) {
        throw new IdentityStoreError(
          'team-org-mismatch',
          `team ${input.teamId} belongs to org ${team.orgId}, not ${input.orgId}`,
        );
      }
      if (
        snapshot.projectTeams.some((row) => row.projectRoot === projectRoot)
      ) {
        throw new IdentityStoreError(
          'project-root-taken',
          `project root ${projectRoot} is already assigned to an org`,
        );
      }
      const projectTeam = projectTeamSchema.parse({
        projectRoot,
        orgId: input.orgId,
        teamId: input.teamId,
      });
      return {
        snapshot: {
          ...snapshot,
          projectTeams: [...snapshot.projectTeams, projectTeam],
        },
        result: projectTeam,
      };
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
      const projectTeams = snapshot.projectTeams.filter(
        (row) => row.projectRoot !== projectRoot,
      );
      return {
        snapshot: { ...snapshot, projectTeams },
        result: projectTeams.length !== snapshot.projectTeams.length,
      };
    });
  }

  /**
   * **IMPLEMENTED (5c, D2, D4 — Fill unit 3, team CRUD store+HTTP).** Originally landed by the
   * 5b/5c/8 scaffold pass as a declared-but-throwing stub for Fill unit 3 to fill in; the body
   * below IS that fill, so this comment no longer describes a gap. Reassigns an already-claimed
   * project root to a DIFFERENT team in the SAME org — the one write
   * `createProjectTeam`/`deleteProjectTeam` cannot express safely: delete-then-create is two
   * guarded writes, not one, and the window between them is exactly the "two processes over one
   * leaseless `.ai/cezar`" hazard D4 exists to close (`server.ts#registerFolder` already discards
   * an explicit `teamId` for an already-claimed root for this reason — see its own comment). This
   * method is what lets a caller change the team WITHOUT ever releasing the org's claim on the
   * root.
   *
   * Takes an already-normalized root, like `getProjectTeam`/`deleteProjectTeam` and unlike
   * `createProjectTeam` — the root being reassigned is by definition already registered, so there
   * is no "resolve a fresh symlink" case to handle here that those two readers don't already cover.
   *
   * Checks the implementation must perform, inside ONE `guardedWrite` (re-read fresh under the
   * lease, never a value captured before it was acquired):
   *  - `project-root-not-found` (declared in `IdentityStoreErrorCode` above) if no `project_teams`
   *    row exists for `projectRoot` — this method reassigns an existing claim, it does not create
   *    one; the caller wants `createProjectTeam` for that.
   *  - `team-not-found` if `teamId` names no team.
   *  - `team-org-mismatch` if that team belongs to a DIFFERENT org than the existing row's `orgId`
   *    — **this is the D4 guard, and it is deliberately checked against the EXISTING row's `orgId`,
   *    never a caller-supplied one**: this method's signature takes no `orgId` parameter precisely
   *    so a reassignment can never smuggle a root across the process boundary D4 draws — it can
   *    only move a root between two teams of the ONE org that already claimed it.
   *  - On success: replace the row's `teamId` in place, `orgId`/`projectRoot` unchanged, and return
   *    the updated row — the same "find index, validate, splice one row" shape `renameTeam` above
   *    already uses.
   *
   * **The HTTP surface built on top of this (LANDED, Fill unit 3, ADDED 2026-08-07):**
   * `PATCH /api/v1/projects/:projectId`'s additive `teamId` field
   * (`packages/contract/src/projects.ts`'s `updateProjectInputSchema`) for the single-process path
   * — that route already calls `mayActOnRoot` before writing (`server.ts`), so the D4 read-side
   * check is inherited for free — and, for supervisor mode (D4 amendment 2's "phase 6 must REPLACE,
   * not join"), `PATCH /internal/project-teams` on `supervisor/server.ts` beside the existing
   * `POST`/`DELETE` on that same path, org-scoped via `callerMayUseOrgId` on the EXISTING row's
   * `orgId` exactly like `DELETE /internal/project-teams/by-root` already is — and classified in
   * `server.test.ts`'s `ADMIN_ONLY`/`ORG_SCOPED` two-directional inventory (as `ORG_SCOPED`,
   * `POST`'s own sibling).
   */
  async updateProjectTeam(
    projectRoot: string,
    teamId: string,
  ): Promise<ProjectTeam> {
    return this.guardedWrite((snapshot) => {
      const index = snapshot.projectTeams.findIndex(
        (row) => row.projectRoot === projectRoot,
      );
      const existing = snapshot.projectTeams[index];
      if (!existing)
        throw new IdentityStoreError(
          'project-root-not-found',
          `no project_teams claim for ${projectRoot}`,
        );
      const team = snapshot.teams.find((t) => t.id === teamId);
      if (!team)
        throw new IdentityStoreError('team-not-found', `no team ${teamId}`);
      if (team.orgId !== existing.orgId) {
        throw new IdentityStoreError(
          'team-org-mismatch',
          `team ${teamId} belongs to org ${team.orgId}, not ${existing.orgId}`,
        );
      }
      const updated = projectTeamSchema.parse({ ...existing, teamId });
      const projectTeams = [...snapshot.projectTeams];
      projectTeams[index] = updated;
      return { snapshot: { ...snapshot, projectTeams }, result: updated };
    });
  }

  /**
   * Delete a team (5c, D2 — ADDED this pass, Fill unit 3; no method existed before). Mirrors
   * `renameTeam` above rather than `deleteSession`/`deleteProjectTeam`'s idempotent-no-op shape:
   * `team-not-found` is a THROW, not a silent `false` — a caller acting on a specific team by id
   * (the only shape `DELETE /auth/teams/:teamId` has) gets the same not-found signal `renameTeam`
   * already gives for the identical mistake, rather than a boolean the route would have to
   * re-interpret. (`team-routes.ts`'s own HTTP handler pre-checks `getTeamById` anyway, for the
   * cross-org 404 — see its own comment — so this throw is defense in depth, not the only guard.)
   *
   * **The decision this method IS: refuse, never reassign, when the team still has projects.**
   * `snapshot.projectTeams.some(row => row.teamId === id)` — if any project is still claimed by
   * this team, the delete is refused with `team-has-projects` rather than either (a) silently
   * releasing those rows (an orphaned project with no team, which the spec's own instruction for
   * this method rules out by name) or (b) silently reassigning them to some other team this store
   * would have to guess at (the org's default team? whichever team is `[0]`? — a real product
   * decision this store has no basis to make on a caller's behalf, and a WRONG guess is worse than
   * a refusal because it moves a project's assignment without anyone asking for that). The caller
   * that wants to delete a team with projects on it must reassign each one first
   * (`updateProjectTeam` above), then delete — the same "move it, then remove it" two-step shape
   * `deleteProjectTeam`'s own doc comment already describes for the release-before-reclaim case.
   *
   * **The second decision, ADDED 2026-08-07 (5b/5c/8 repair stage): an org's LAST team may never be
   * deleted (`team-is-last`).** `session.ts#resolveIdentity` resolves a signed-in user's
   * `principal.teamId` as `listTeams(membership.orgId)[0]` and returns `null` when there is none —
   * so an org with zero teams resolves NO principal for ANY of its members, owner included.
   * Reproduced at review against the real store and the real routes: deleting a brand-new org's one
   * (project-free, therefore `team-has-projects`-passing) team answered `200 {"deleted":true}` and
   * then `GET /auth/me`, `GET /auth/teams`, `POST /auth/teams` and `POST /auth/invites` all answered
   * **401** for every member — and every recovery door is shut. `claimOrg`'s legacy branch needs
   * `orgs.length === 0`; its D11 branch needs an unclaimed org; `/internal/*` has no team-create
   * verb; and a FRESH user redeeming a valid invite into the team-less org gets 201 and then
   * resolves `null` too. On the D10 topology `/internal/auth-check` 401s, so nginx's `auth_request`
   * fails every request to that org's vhost: total blackout, recoverable only by hand-editing
   * `identity.json` as that org's unix user.
   *
   * This is a STORE invariant, not a route check, for the same reason every other one in this class
   * is: `deleteTeam` is reachable from `DELETE /auth/teams/:teamId` today and from whatever calls it
   * next, and "the guarantee decays to 'every caller remembered'" (D7) is exactly what a route-level
   * count would be. An admin who wants no team named `General` renames it (`renameTeam`), or creates
   * the replacement FIRST and deletes after — both already possible through `/auth/teams*`.
   */
  async deleteTeam(id: string): Promise<void> {
    return this.guardedWrite((snapshot) => {
      const team = snapshot.teams.find((candidate) => candidate.id === id);
      if (!team) {
        throw new IdentityStoreError('team-not-found', `no team ${id}`);
      }
      if (
        snapshot.teams.filter((candidate) => candidate.orgId === team.orgId)
          .length <= 1
      ) {
        throw new IdentityStoreError(
          'team-is-last',
          `team ${id} is the only team in org ${team.orgId} — an org with no teams locks every one of its members out`,
        );
      }
      if (snapshot.projectTeams.some((row) => row.teamId === id)) {
        throw new IdentityStoreError(
          'team-has-projects',
          `team ${id} still has projects assigned to it — reassign them before deleting the team`,
        );
      }
      const teams = snapshot.teams.filter((team) => team.id !== id);
      return { snapshot: { ...snapshot, teams }, result: undefined };
    });
  }

  /** `id` is REQUIRED and caller-supplied — see `sessionSchema`'s doc comment on why the store
   *  never mints session ids itself. A collision is treated as a bug in the caller's randomness,
   *  not a retryable condition, so it throws rather than silently overwriting someone's session. */
  async createSession(input: {
    id: string;
    userId: string;
    expiresAt: Date;
  }): Promise<Session> {
    return this.guardedWrite((snapshot) => {
      if (!snapshot.users.some((user) => user.id === input.userId)) {
        throw new IdentityStoreError(
          'user-not-found',
          `no user ${input.userId}`,
        );
      }
      if (snapshot.sessions.some((s) => s.id === input.id)) {
        throw new IdentityStoreError(
          'session-id-taken',
          `session id ${input.id} already exists`,
        );
      }
      const now = this.now();
      // Opportunistic prune on every session write, mirroring `AutomationStore`'s tombstone
      // pruning on every definitions write — sessions accumulate on every sign-in and nothing else
      // ever visits every row, so "prune when we're already holding the lease and writing anyway"
      // is the only hook that reliably runs.
      const pruned = snapshot.sessions.filter(
        (s) => Date.parse(s.expiresAt) > now.getTime(),
      );
      const session = sessionSchema.parse({
        id: input.id,
        userId: input.userId,
        expiresAt: input.expiresAt.toISOString(),
        createdAt: now.toISOString(),
      });
      return {
        snapshot: { ...snapshot, sessions: [...pruned, session] },
        result: session,
      };
    });
  }

  /** Logout. Idempotent — deleting an already-gone/expired session is not an error, it returns
   *  `false` rather than throwing. */
  async deleteSession(id: string): Promise<boolean> {
    return this.guardedWrite((snapshot) => {
      const sessions = snapshot.sessions.filter((s) => s.id !== id);
      return {
        snapshot: { ...snapshot, sessions },
        result: sessions.length !== snapshot.sessions.length,
      };
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
        if (!team)
          throw new IdentityStoreError(
            'team-not-found',
            `no team ${input.teamId}`,
          );
        if (team.orgId !== input.orgId) {
          throw new IdentityStoreError(
            'team-org-mismatch',
            `team ${input.teamId} belongs to org ${team.orgId}, not ${input.orgId}`,
          );
        }
      }
      if (snapshot.invites.some((invite) => invite.id === input.id)) {
        throw new IdentityStoreError(
          'invite-id-taken',
          `invite id ${input.id} already exists`,
        );
      }
      const invite = inviteSchema.parse({
        id: input.id,
        orgId: input.orgId,
        teamId: input.teamId,
        role: input.role,
        createdAt: this.now().toISOString(),
        expiresAt: input.expiresAt.toISOString(),
      });
      return {
        snapshot: { ...snapshot, invites: [...snapshot.invites, invite] },
        result: invite,
      };
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
   *  - `user-already-member` (ADDED 2026-08-07, 5b/5c/8 repair stage) if that user has a membership
   *    in a DIFFERENT org — see the check's own comment below, and `IdentityStoreErrorCode`'s
   *    `user-already-member` note, for why a 201 there was a false grant that also burnt the token.
   *
   * On success: stamp `consumedAt`/`consumedByUserId` on the invite row AND insert the new
   * `Membership` row (role from `invite.role`), both in the returned `snapshot`.
   */
  async redeemInvite(input: {
    id: string;
    userId: string;
  }): Promise<{ invite: Invite; membership: Membership }> {
    return this.guardedWrite((snapshot) => {
      const index = snapshot.invites.findIndex(
        (invite) => invite.id === input.id,
      );
      const existing = snapshot.invites[index];
      if (!existing)
        throw new IdentityStoreError(
          'invite-not-found',
          `no invite ${input.id}`,
        );
      if (existing.consumedAt)
        throw new IdentityStoreError(
          'invite-already-consumed',
          `invite ${input.id} was already consumed`,
        );
      if (Date.parse(existing.expiresAt) <= this.now().getTime()) {
        throw new IdentityStoreError(
          'invite-expired',
          `invite ${input.id} expired at ${existing.expiresAt}`,
        );
      }
      if (!snapshot.users.some((user) => user.id === input.userId)) {
        throw new IdentityStoreError(
          'user-not-found',
          `no user ${input.userId}`,
        );
      }
      if (
        snapshot.memberships.some(
          (m) => m.userId === input.userId && m.orgId === existing.orgId,
        )
      ) {
        throw new IdentityStoreError(
          'membership-exists',
          `user ${input.userId} is already a member of org ${existing.orgId}`,
        );
      }
      // ---- a member of ANOTHER org cannot redeem (ADDED 2026-08-07, 5b/5c/8 repair stage; see
      // `IdentityStoreErrorCode`'s `user-already-member` note for the general rule).
      //
      // **The failure this closes, reproduced at review.** A `member` of org A redeeming org B's
      // `owner` invite got `201 {"orgId": B, "role": "owner"}` — and then resolved as an org-A
      // `member` on every subsequent request, because `session.ts#resolveIdentity` takes
      // `listMemberships(userId)[0]`. The response asserted a grant the product structurally could
      // not deliver, and the single-use token was stamped `consumedAt` in the same write, so org
      // B's owner could not even re-send it: the next invite failed identically. That is "a silent
      // fallback is indistinguishable from success", and it was the ONLY outcome for an invitee who
      // already belonged to an org — the exact population a multi-org host produces.
      //
      // Refusing THROWS, so `guardedWrite` returns no new snapshot and the invite stays UNCONSUMED
      // and revocable — which is the whole point: the credential remains spendable once an
      // active-org selector exists (F4), instead of having been burnt on a no-op.
      if (snapshot.memberships.some((m) => m.userId === input.userId)) {
        throw new IdentityStoreError(
          'user-already-member',
          `user ${input.userId} already belongs to another organization on this deployment`,
        );
      }
      const consumedInvite = inviteSchema.parse({
        ...existing,
        consumedAt: this.now().toISOString(),
        consumedByUserId: input.userId,
      });
      const membership = membershipSchema.parse({
        userId: input.userId,
        orgId: existing.orgId,
        role: existing.role,
      });
      const invites = [...snapshot.invites];
      invites[index] = consumedInvite;
      return {
        snapshot: {
          ...snapshot,
          invites,
          memberships: [...snapshot.memberships, membership],
        },
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
      const isActive =
        existing !== undefined &&
        !existing.consumedAt &&
        Date.parse(existing.expiresAt) > this.now().getTime();
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
      writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          startedAt: this.now().toISOString(),
        }),
      );
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
  private async guardedWrite<T>(
    mutate: (snapshot: IdentitySnapshot) => {
      snapshot: IdentitySnapshot;
      result: T;
    },
  ): Promise<T> {
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
      this.warnOnce(
        'parse',
        `Ignored a corrupt ${SNAPSHOT_FILE} — identity reads as empty until the next successful write.`,
      );
      return emptyIdentitySnapshot();
    }
    if (typeof raw !== 'object' || raw === null) {
      this.warnOnce(
        'parse',
        `Ignored a malformed ${SNAPSHOT_FILE} (not an object) — identity reads as empty until the next successful write.`,
      );
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
      memberships: this.salvage(
        obj.memberships,
        membershipSchema,
        'memberships',
      ),
      projectTeams: this.salvage(
        obj.projectTeams,
        projectTeamSchema,
        'projectTeams',
      ),
      sessions: this.salvage(obj.sessions, sessionSchema, 'sessions'),
      // A file written before this scaffold added `invites` (i.e. every identity.json on disk
      // today) simply has no `invites` key — `obj.invites` is `undefined`, and `salvage` already
      // treats a non-array as "no rows" rather than throwing, so this reads as `[]` exactly like
      // `emptyIdentitySnapshot()`'s own default. No migration needed (D7/AGENTS.md: new fields are
      // additive, never required of an old file).
      invites: this.salvage(obj.invites, inviteSchema, 'invites'),
    };
  }

  private salvage<T>(
    value: unknown,
    schema: { safeParse(v: unknown): { success: boolean; data?: T } },
    label: string,
  ): T[] {
    if (!Array.isArray(value)) return [];
    const rows: T[] = [];
    let dropped = 0;
    for (const row of value) {
      const parsed = schema.safeParse(row);
      if (parsed.success && parsed.data !== undefined) rows.push(parsed.data);
      else dropped += 1;
    }
    if (dropped > 0)
      this.warnOnce(
        label,
        `Skipped ${dropped} malformed "${label}" row(s) in ${SNAPSHOT_FILE}.`,
      );
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
    writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, {
      mode: 0o600,
    });
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
