import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  emptyOrgProcessRegistry,
  orgProcessRecordSchema,
  orgProcessRegistrySchema,
  type OrgProcessRecord,
  type OrgProcessRegistry,
} from './org-process-registry.ts';

/**
 * The `O_EXCL`-leased store `org-process-registry.ts`'s own doc comment says is "Fill unit 1's to
 * build" — the same house idiom `../auth/identity-store.ts` already uses (D7): `openSync(path,
 * 'wx', 0o600)` for the write lease, tmp+rename for the write itself, no in-memory cache (every
 * read re-parses the file fresh, for the identical reason `identity-store.ts`'s own module doc
 * gives: this store must be safe to read from a synchronous `SessionResolver`-shaped call with
 * nowhere to `await`, and a cached snapshot could hand back infrastructure another writer had
 * already changed underneath it).
 *
 * **What this store is FOR, precisely** (D10, D4's "process lifecycle"):
 *  - `register` is the "start" half — it is what makes `OrgProcessRecord#status` go `'active'`,
 *    and it is the ONE place D4's "refuse to start two processes for one org" is enforced: a
 *    second `register` for an org that already has an active record is refused outright, not
 *    silently overwritten (`org-already-provisioned`). Hostname and loopback port are checked the
 *    same way — either colliding with a DIFFERENT org's active record is refused too, since nginx's
 *    static per-org `proxy_pass`/`server_name` config (D10, phase 7's `hetzner` platform) can only
 *    ever be correct if both are unique across active orgs.
 *  - `deprovision` is the "stop" half — flips the record to `'deprovisioned'` rather than deleting
 *    it, on `identity-store.ts#revokeInvite`'s own precedent: a later admin/audit view over "every
 *    org this host has ever hosted" needs the row to still be there. Idempotent, same shape as
 *    `IdentityStore#deleteSession`/`#revokeInvite`.
 *  - `getActiveByOrgId`/`getActiveByHostname`/`getActiveBySlug` are the "hostname -> org -> process
 *    resolution" reads: `getActiveByHostname` is what a phase-7 nginx-config generator (or an
 *    operator diagnosing "which org owns this domain") resolves a public hostname against;
 *    `getActiveByOrgId` is what `supervisor/auth-request.ts`'s `/internal/auth-check` handler
 *    looks the caller's own resolved org up in to find the secret to sign with.
 *  - "Health" beyond the stored `status` field is deliberately NOT this store's job — a live TCP/
 *    HTTP probe of an org's loopback port is a property of the RUNNING process, not of this JSON
 *    record, and `supervisor/server.ts`'s `/internal/org-processes/:orgId/health` route composes
 *    a probe on top of a `getActiveByOrgId` read rather than this store growing a network call of
 *    its own (a JSON store making outbound HTTP requests would be a strange thing to unit-test and
 *    a strange thing to trust).
 *
 * **Restart survival is structural, not a feature added here.** Every read goes through
 * `readSnapshot`, which re-parses `<CEZ_HOME>/supervisor/org-process-registry.json` off disk on
 * every call — there is no in-memory registry to lose across a process restart, the same
 * "the file IS the state" property `IdentityStore` already has and for the identical reason (see
 * that class's own module doc on why no cache).
 */

const REGISTRY_FILE = 'org-process-registry.json';
const LOCK_FILE = 'org-process-registry.lock';

/** Cap on the exponential backoff between lease retries — mirrors `identity-store.ts`'s own
 *  constant of the same name and purpose. */
const MAX_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type OrgProcessRegistryErrorCode =
  | 'org-already-provisioned'
  | 'hostname-taken'
  | 'port-taken'
  | 'lease-timeout';

/** Thrown by every guarded write below in place of a SQL engine's constraint violation — the same
 *  role `IdentityStoreError` plays for `identity-store.ts` (D7: "every UNIQUE/PRIMARY KEY … is a
 *  check performed inside the write lease"). */
export class OrgProcessRegistryError extends Error {
  constructor(
    readonly code: OrgProcessRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OrgProcessRegistryError';
  }
}

export interface OrgProcessRegistryOptions {
  warn?: (message: string) => void;
  now?: () => Date;
  /** Same default and reasoning as `identity-store.ts#IdentityStoreOptions.lockTimeoutMs`: under
   *  D10 this store is written only by the single supervisor process, so real contention is two of
   *  its OWN concurrent requests at worst (two provisioning calls landing together). */
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  staleLeaseMs?: number;
}

export class OrgProcessRegistryLease {
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

/** What `register` accepts — every `OrgProcessRecord` field except the two this store computes
 *  itself (`status` always starts `'active'`; `createdAt` is stamped fresh), so a caller cannot
 *  claim to be re-provisioning an already-deprovisioned org by forging either. */
export type OrgProcessRegistrationInput = Omit<OrgProcessRecord, 'status' | 'createdAt'>;

export class OrgProcessRegistryStore {
  private readonly warned = new Set<string>();
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly staleLeaseMs: number;

  static open(dir: string, options: OrgProcessRegistryOptions = {}): OrgProcessRegistryStore {
    return new OrgProcessRegistryStore(dir, options);
  }

  private constructor(
    readonly dir: string,
    private readonly options: OrgProcessRegistryOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.lockRetryMs = options.lockRetryMs ?? 10;
    this.staleLeaseMs = options.staleLeaseMs ?? 10 * 60_000;
  }

  // ---- reads: always fresh off disk, never throw, never create state ---------------------------

  /** Every record this host has ever provisioned, active or not — an audit/history read, never
   *  used for routing decisions (those go through the `getActive*` methods below, which are what
   *  actually enforce "at most one active record per org"). */
  list(): OrgProcessRecord[] {
    return this.readSnapshot().orgs;
  }

  getActiveByOrgId(orgId: string): OrgProcessRecord | undefined {
    return this.readSnapshot().orgs.find((org) => org.orgId === orgId && org.status === 'active');
  }

  /** The "hostname -> org" half of hostname -> org -> process resolution. Active-only: a
   *  deprovisioned org's hostname is free for a DIFFERENT org to claim later (`register` enforces
   *  that at write time by checking this same predicate), so a lookup here must not resurrect a
   *  stale claim. */
  getActiveByHostname(hostname: string): OrgProcessRecord | undefined {
    return this.readSnapshot().orgs.find((org) => org.hostname === hostname && org.status === 'active');
  }

  getActiveBySlug(orgSlug: string): OrgProcessRecord | undefined {
    return this.readSnapshot().orgs.find((org) => org.orgSlug === orgSlug && org.status === 'active');
  }

  // ---- writes: async, retry-and-block on lease contention, one guarded helper ------------------

  /**
   * The "start" half of process lifecycle, and the enforcement point for D4's "refuse to start two
   * processes for one org" — checked on the snapshot `guardedWrite` re-reads FRESH under the lease
   * (the same "never a check the caller performs first and then acts on" discipline
   * `identity-store.ts#bootstrapFirstOrg`'s own doc comment argues for, applied here to the same
   * shape of race: two provisioning calls for the same org landing together must not both succeed).
   *
   * Three checks, each against ACTIVE records only (a deprovisioned org's old hostname/port/org id
   * is free to be reused — by itself, on re-provisioning, or by a different org):
   *  - `org-already-provisioned`: this org already has a running process.
   *  - `hostname-taken`: a DIFFERENT org's active process already answers this hostname — nginx's
   *    static per-hostname routing (D10, phase 7) can only be correct if this is unique.
   *  - `port-taken`: a DIFFERENT org's active process already binds this loopback port, for the
   *    identical reason on the `proxy_pass` side.
   *
   * On success the new record is APPENDED, never overwriting a prior (deprovisioned) row for the
   * same org — `identity-store.ts#revokeInvite`'s own "keep the history" precedent, applied here so
   * `list()` can answer "every org this host has ever hosted", not just its current roster.
   */
  async register(input: OrgProcessRegistrationInput): Promise<OrgProcessRecord> {
    return this.guardedWrite((snapshot) => {
      const activeForOrg = snapshot.orgs.find((org) => org.orgId === input.orgId && org.status === 'active');
      if (activeForOrg) {
        throw new OrgProcessRegistryError(
          'org-already-provisioned',
          `org ${input.orgId} already has an active process (hostname ${activeForOrg.hostname}, port ${activeForOrg.loopbackPort})`,
        );
      }
      const hostnameClash = snapshot.orgs.find((org) => org.hostname === input.hostname && org.status === 'active' && org.orgId !== input.orgId);
      if (hostnameClash) {
        throw new OrgProcessRegistryError(
          'hostname-taken',
          `hostname ${input.hostname} is already routed to org ${hostnameClash.orgId}`,
        );
      }
      const portClash = snapshot.orgs.find((org) => org.loopbackPort === input.loopbackPort && org.status === 'active' && org.orgId !== input.orgId);
      if (portClash) {
        throw new OrgProcessRegistryError(
          'port-taken',
          `loopback port ${input.loopbackPort} is already bound to org ${portClash.orgId}`,
        );
      }
      const record = orgProcessRecordSchema.parse({
        ...input,
        status: 'active',
        createdAt: this.now().toISOString(),
      });
      return { snapshot: { ...snapshot, orgs: [...snapshot.orgs, record] }, result: record };
    });
  }

  /** The "stop" half. Idempotent, mirroring `identity-store.ts#deleteSession`/`#revokeInvite`:
   *  deprovisioning an org with no active record (unknown org, or already deprovisioned) is not an
   *  error, it returns `false`. Flips `status` in place rather than removing the row — see the
   *  class doc comment on why history is kept. */
  async deprovision(orgId: string): Promise<boolean> {
    return this.guardedWrite((snapshot) => {
      const index = snapshot.orgs.findIndex((org) => org.orgId === orgId && org.status === 'active');
      if (index === -1) return { snapshot, result: false };
      const updated = orgProcessRecordSchema.parse({ ...snapshot.orgs[index], status: 'deprovisioned' });
      const orgs = [...snapshot.orgs];
      orgs[index] = updated;
      return { snapshot: { ...snapshot, orgs }, result: true };
    });
  }

  // ---- lease + transaction plumbing --------------------------------------------------------------
  // Byte-for-byte the same idiom as `identity-store.ts`'s own lease/guardedWrite pair — see that
  // class's doc comments for the reasoning (retry-and-block rather than one-shot, because a
  // provisioning request silently no-oping on lease contention is not an acceptable failure mode;
  // stale-lease reclaim for a writer that crashed mid-write).

  acquireLease(staleAfterMs = this.staleLeaseMs): OrgProcessRegistryLease | undefined {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, LOCK_FILE);
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: this.now().toISOString() }));
      return new OrgProcessRegistryLease(path, fd);
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

  private async acquireLeaseBlocking(): Promise<OrgProcessRegistryLease> {
    const deadline = Date.now() + this.lockTimeoutMs;
    let delay = this.lockRetryMs;
    for (;;) {
      const lease = this.acquireLease();
      if (lease) return lease;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new OrgProcessRegistryError(
          'lease-timeout',
          `org-process registry write lease stayed held for over ${this.lockTimeoutMs}ms — another writer may be stuck`,
        );
      }
      await sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
    }
  }

  private async guardedWrite<T>(mutate: (snapshot: OrgProcessRegistry) => { snapshot: OrgProcessRegistry; result: T }): Promise<T> {
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

  /** Never creates the directory or the file — a read must not materialize state, matching
   *  `identity-store.ts#readSnapshot`'s own stance. Missing file degrades to
   *  `emptyOrgProcessRegistry()` silently; a corrupt one degrades the same way with one warning. */
  private readSnapshot(): OrgProcessRegistry {
    const path = join(this.dir, REGISTRY_FILE);
    if (!existsSync(path)) return emptyOrgProcessRegistry();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      this.warnOnce('parse', `Ignored a corrupt ${REGISTRY_FILE} — the org-process registry reads as empty until the next successful write.`);
      return emptyOrgProcessRegistry();
    }
    const parsed = orgProcessRegistrySchema.safeParse(raw);
    if (!parsed.success) {
      this.warnOnce('parse', `Ignored a malformed ${REGISTRY_FILE} — the org-process registry reads as empty until the next successful write.`);
      return emptyOrgProcessRegistry();
    }
    return parsed.data;
  }

  /** `orgProcessRegistrySchema.parse` (not `safeParse`) here is a deliberate internal assertion,
   *  the same one `identity-store.ts#writeSnapshot` makes for the identical reason: by the time a
   *  snapshot reaches this method it was built by one of this class's own `mutate` callbacks from
   *  already-validated rows, so a failure here means a bug in THIS file. */
  private writeSnapshot(snapshot: OrgProcessRegistry): void {
    const validated = orgProcessRegistrySchema.parse(snapshot);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, REGISTRY_FILE);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    try {
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
