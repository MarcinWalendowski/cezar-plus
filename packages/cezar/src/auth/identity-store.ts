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
  membershipSchema,
  orgSchema,
  projectTeamSchema,
  sessionSchema,
  teamSchema,
  userSchema,
  type IdentitySnapshot,
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
  | 'lease-timeout';

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
   * D4's hard constraint: "a project root may belong to exactly one org … `RunStore` has no
   * lease, [so two processes over one `.ai/cezar`] is silent history loss, not a leak." The
   * `realpathSync` below is what makes that constraint mean something — a bare string PK would let
   * a symlink and its target register as two different roots, each innocently believing it alone
   * owns that `.ai/cezar`. This is the ONE place identity-store resolves a project root; readers
   * (`getProjectTeam`, `listProjectTeams`) take an already-normalized root by contract rather than
   * re-resolving (and risking an `ENOENT` on a root a caller is merely filtering by, not touching).
   */
  async createProjectTeam(input: { projectRoot: string; orgId: string; teamId: string }): Promise<ProjectTeam> {
    const projectRoot = realpathSync(input.projectRoot);
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
    // `.passthrough()` contract every row schema below gets, applied by hand here because the six
    // known keys are rebuilt individually (per-entry salvage, not `identitySnapshotSchema.parse`
    // wholesale) rather than round-tripped as-is.
    const KNOWN_KEYS = new Set(['version', 'orgs', 'teams', 'users', 'memberships', 'projectTeams', 'sessions']);
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
