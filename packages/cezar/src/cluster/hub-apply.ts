import { promises as fs } from 'node:fs';
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ClusterOp } from '@loki-labs/cezar-plus-contract';
import { storedTodoSchema, todosPath, type TodoItem } from '../todos.ts';
import { applyOpToRecord } from './replica.ts';
import type { HubOpOutcome, HubOpsDeps } from './hub-ops.ts';

/**
 * What `cluster/hub-ops.ts#HubOpsDeps['applyOp']` actually DOES: applying one op to the hub's own
 * `todos.json`, under the same write lease every local writer of that file takes (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, "What remains" → Milestone B; D4 · D6 · D7 ·
 * D9a). `hub-ops.ts` owns the per-frame orchestration (allocation, idempotence cache, the
 * reject-vs-throw contract, `throughHubSeq`); this file owns the one thing it injects — what
 * actually happens to the record.
 *
 * **D7 — through the store API, never by writing the file.** `todos.ts` is the only module that
 * knows this file's on-disk shape and lease discipline, and this file must not become a second
 * writer that can drift from it. The trouble: `todos.ts` exposes no primitive shaped like what a
 * hub-side op needs — every exported writer (`createTodo`, `updateTodo`, `removeTodo`,
 * `markStartedWithClaim`, `applyHubReplica`) hard-codes its OWN decision, and none of them is "read
 * fresh, decide accept/reject with the full record in hand, write only on accept." In particular
 * `applyHubReplica` (`cluster/replica.ts#applyReplica` under the hood) is the wrong shape for this
 * job even though it looks adjacent: its merge is an unconditional per-field `Object.assign`
 * (`applyOpToRecord`, reused below) with NO notion of "already claimed by someone else" — it exists
 * to apply the HUB's OWN already-decided values down onto a SPOKE, not to make the decision. Feeding
 * a claim op through it blindly would let whichever of two racing `applyHubReplica` calls happens to
 * acquire `todos.ts`'s internal lease SECOND silently clobber the first — the exact double-claim
 * D9a exists to prevent, wearing a different hat.
 *
 * So the decision needs a read-decide-write cycle that is atomic against every OTHER writer of this
 * project's `todos.json`, and the primitive that provides that (`withTodosLease`, plus `readRaw` /
 * `writeAtomic`) is private to `todos.ts` — not exported, and this package may not edit that file
 * (owned by a sibling package for this increment). This file's lease below is therefore a
 * **restatement** of `todos.ts#acquireTodosLease`'s `O_EXCL` idiom, not a new invention —
 * `cluster/hub-seq.ts` already sets the precedent of restating this exact idiom per-store rather
 * than sharing one generic helper (its own docblock: "the `todos.ts#acquireTodosLease` `O_EXCL`
 * idiom, restated for this store rather than shared"). This restatement is a stricter case than
 * `hub-seq.ts`'s, though, and worth being honest about: `hub-seq.json` has exactly one writer
 * anywhere in the system (`hub-seq.ts` itself), so a dedicated lock file for it is genuinely
 * independent. `todos.json` is not — `todos.ts` already has five writers of it — so for this lease
 * to mean anything it MUST use the identical lock file path `todos.ts` uses
 * (`<dataDir>/todos.lock`), not a new one, so the OS-level `O_EXCL` exclusivity actually serializes
 * against those five writers rather than merely against itself. That is a real, tighter coupling
 * than `hub-seq.ts` carries, kept only because there is no exported alternative. **The fix, when
 * `todos.ts` is next open for change, is to delete this duplication**: either export
 * `withTodosLease`/`readRaw`/`writeAtomic`, or add a single `applyHubOp(dataDir, op, decide)`
 * primitive to `todos.ts` itself, which owns the format and could then own this decision too rather
 * than reasoning about it from outside. Flagged in the implementation report rather than done
 * silently, per this package's own instructions.
 *
 * **D9a — the claim decision.** An `upsert` op whose `fields.startedTaskId` is a non-empty string is
 * a claim. Under the lease's fresh read: if the record already carries a DIFFERENT
 * `startedTaskId`, this op lost — `{ accepted: false, reason: 'already-started', fields }`, where
 * `fields` carries the winner's own `startedTaskId`/`startedOn` (never this op's proposal), and
 * nothing is written. That is a considered, durable verdict (hub-ops.ts's own vocabulary): retrying
 * the identical op will not change it, because the state that produced it — someone else's
 * `startedTaskId` already on the record — does not change by being asked again. If the record has
 * no claim yet, or already carries THIS SAME `startedTaskId` (a resend of the winning claim itself,
 * whose earlier `ack` the spoke never saw — see `markStartedWithClaim`'s own note on why a
 * successful claim leaves nothing `pendingSince` for the outbox to owe, which is what makes this
 * resend path reachable at all), the claim proceeds and is accepted.
 *
 * `startedOn` is not a timestamp — `contract/src/cluster.ts#clusterTodoFieldsSchema` types it as
 * `clusterNodeIdSchema`: "the node this todo's run was claimed on." So an accepted claim stamps
 * `startedOn = op.nodeId` (the AUTHORING node's own id, per `ClusterOp.nodeId`'s own docblock: "not
 * a tiebreak … the attribution a correction is rendered with"), never a clock read — there is
 * nothing here for an injected `now()` to do, deliberately.
 *
 * **D4/D9 — staleness is a separate, more general guard, and runs AFTER the claim check, never
 * before.** Two frames from two different nodes touching the SAME entity can reach this lease in
 * EITHER order relative to their `hubSeq` allocation — allocation order and lease-acquisition order
 * are independent once two frames are being processed concurrently by `hub-ops.ts`. For an ordinary
 * (non-claim) field op that matters: an op whose `hubSeq` is at or below the record's own already
 * carries a skip, not a re-apply, so a lower-numbered op that happens to arrive at this lease AFTER
 * a higher-numbered one can never regress it. But it must run AFTER the claim check, not instead of
 * it: a LOSING claim can easily carry a LOWER `hubSeq` than the winner's (whichever frame reaches
 * this lease first wins, regardless of allocation order) and if the staleness guard fired first it
 * would silently answer `{ accepted: true }` for a claim that lost — the spoke would read that as
 * permission to start, which is the exact double-start this module exists to prevent. The claim
 * check's own conflict test does not need `hubSeq` at all (it is keyed on "does the record already
 * name someone else"), which is what makes it correct independent of write-arrival order.
 *
 * **Corrected 2026-08-23 — running the staleness guard after the claim check is necessary and NOT
 * sufficient; a claim now skips that guard entirely.** The paragraph above reasoned only about a
 * claim that LOSES, and ordering does protect that one. It leaves the mirror case open: a claim on
 * a still-UNCLAIMED row, where an ordinary field op from another node reached this lease first and
 * carried the record's `hubSeq` past the claim's own. That claim passes the conflict check (nobody
 * holds it), then meets `op.hubSeq <= existing.hubSeq` and is answered `{ accepted: true }` with
 * nothing written and no `fields` — and `accepted` is precisely the spoke's permission to START
 * (`todos.ts#markStartedWithClaim` calls `start()` on it). The hub would be granting a run it has no
 * record of, and would grant the NEXT node's claim on the same row the same way: the double start
 * this module exists to prevent, arriving through the guard rather than around it. So the guard is
 * now `!claiming && …`. "Not strictly newer, therefore nothing to re-apply" is a true statement
 * about a field patch, whose value is already on the record. It is never true of a claim, whose
 * whole purpose is to become the record. The write path compensates by keeping
 * `max(existing.hubSeq, op.hubSeq)` so an out-of-order claim cannot regress the watermark.
 *
 * **D6 — a tombstone op is applied like any other non-claim op** (`applyOpToRecord` already
 * encodes "value, not a hole" — see its own docblock) and is never a removal from the array.
 *
 * **Never fabricate a verdict for an entity this store cannot apply.** `entity: 'todo'` is the only
 * kind this file — or anything else in the tree today (`cluster/ops.ts` derives no other kind) —
 * knows how to store. A `run`/`triage` op reaching here THROWS rather than returning any verdict:
 * per `hub-ops.ts`'s own reject-vs-throw contract, a throw leaves a gap (unacknowledged, retried by
 * the spoke) rather than lying that the hub considered and refused it. That is the honest answer
 * for "not supported by this build yet," which is a different fact from "considered and refused."
 */

const TODOS_LOCK_FILE = 'todos.lock';
const MAX_RETRY_DELAY_MS = 200;
const DEFAULT_STALE_AFTER_MS = 10 * 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/** The passthrough shape `todos.ts#storedTodoSchema` parses with (D13: an older reader must not
 *  truncate a newer node's fields). Declared locally from the exported schema object rather than
 *  imported as a type, because `todos.ts` does not export one. */
type StoredTodoRow = z.infer<typeof storedTodoSchema>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TodosFileLease {
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
      // Already removed — by shutdown cleanup, or by a stale-reclaim from the other side of this
      // exact lock file (todos.ts's own writers use the identical path; see module docblock).
    }
  }
}

/** One non-blocking attempt, restating `todos.ts#acquireTodosLease` against the SAME lock file —
 *  see the module docblock for why identity of the path, not merely of the idiom, is required
 *  here. */
function acquireTodosFileLease(dataDir: string, lockPath: string, staleAfterMs: number): TodosFileLease | undefined {
  mkdirSync(dataDir, { recursive: true });
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), via: 'cluster/hub-apply' }));
    return new TodosFileLease(lockPath, fd);
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > staleAfterMs) {
        unlinkSync(lockPath);
        return acquireTodosFileLease(dataDir, lockPath, staleAfterMs);
      }
    } catch {
      // A contender released it first, or the directory is read-only.
    }
    return undefined;
  }
}

/** Retries with bounded backoff until the lease is acquired or `lockTimeoutMs` elapses, THROWING on
 *  timeout — this is `hub-ops.ts`'s "transient, not a business decision" case in the flesh: a stuck
 *  writer must leave a gap in `throughHubSeq`, never a fabricated `{ accepted: false }`. */
async function acquireTodosFileLeaseBlocking(dataDir: string, lockTimeoutMs: number, staleAfterMs: number): Promise<TodosFileLease> {
  const lockPath = join(dataDir, TODOS_LOCK_FILE);
  const deadline = Date.now() + lockTimeoutMs;
  let delay = 10;
  for (;;) {
    const lease = acquireTodosFileLease(dataDir, lockPath, staleAfterMs);
    if (lease) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `cluster hub-apply: todos.json write lease at ${lockPath} stayed held for over ${lockTimeoutMs}ms — another writer ` +
          'may be stuck. This is a TRANSIENT failure: the caller must not turn it into an accepted:false verdict.',
      );
    }
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
  }
}

async function withTodosFileLease<T>(dataDir: string, options: HubApplyOptions | undefined, fn: () => Promise<T>): Promise<T> {
  const lease = await acquireTodosFileLeaseBlocking(
    dataDir,
    options?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
  );
  try {
    return await fn();
  } finally {
    lease.release();
  }
}

// ---- todos.json read / write — mirrors todos.ts's private readRaw/writeAtomic, minus id-healing
// (never this file's job: an op's `entityId` always names an already-healed id, per D5a) ---------

/** Parses every entry with `storedTodoSchema` (tolerant of unknown keys, D13) and skips a malformed
 *  one with a warning — never throws for bad CONTENT, only for a genuinely stuck lease (see above).
 *  An id-less row (an unhealed raw agent append, D5a — never this file's concern) is kept verbatim
 *  in the returned array at its original position: it can never match an op's `entityId`, so it is
 *  simply carried through untouched on the next write rather than silently dropped. */
async function readTodosRaw(dataDir: string): Promise<StoredTodoRow[]> {
  let raw: string;
  try {
    raw = await fs.readFile(todosPath(dataDir), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return []; // no file yet — the only read failure that means "empty"
    // Deliberately STRICTER than `todos.ts#readRaw`, which answers `[]` for ANY read failure. That
    // is survivable for a reader; here it is destructive, because this function's caller writes the
    // WHOLE array straight back — so an unreadable store would be REPLACED by a single row. The
    // production shape is not hypothetical on this project's own box: a `todos.json` left owned by
    // root in a `cezar`-owned directory fails the read and still passes the `rename`, since rename
    // needs write permission on the directory and not on the file. Thrown, not swallowed: an I/O
    // failure is transient (hub-ops.ts leaves a gap and the spoke resends), where "the content is
    // broken" — handled below — is a fact about the file that a retry cannot change.
    throw new Error(
      `cluster hub-apply: todos.json at ${todosPath(dataDir)} could not be read (${code ?? String(err)}) — refusing to apply, ` +
        'because writing over a store this process could not read would replace it with a single row. This is a TRANSIENT ' +
        'failure: the caller must not turn it into an accepted:false verdict.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] cluster hub-apply: todos.json is not valid JSON — treating as empty (${message})`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn('[cez] cluster hub-apply: todos.json is not a JSON array — treating as empty');
    return [];
  }
  const rows: StoredTodoRow[] = [];
  for (const entry of parsed) {
    const result = storedTodoSchema.safeParse(entry);
    if (!result.success) {
      console.warn(`[cez] cluster hub-apply: skipped a malformed todos.json entry: ${result.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    rows.push(result.data);
  }
  return rows;
}

async function writeTodosRaw(dataDir: string, rows: StoredTodoRow[]): Promise<void> {
  const file = todosPath(dataDir);
  const tmp = `${file}.tmp`;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

// ---- the decision -------------------------------------------------------------------------------

export interface HubApplyOptions {
  /** Test-only override for the write-lease timeout. Production uses `DEFAULT_LOCK_TIMEOUT_MS`,
   *  matching `todos.ts#acquireTodosLeaseBlocking`'s own default. */
  lockTimeoutMs?: number;
  /** Test-only override for stale-lease reclaim. */
  staleAfterMs?: number;
}

/** A claim: an `upsert` proposing a non-empty `startedTaskId`. Narrowed so every read of
 *  `op.fields.startedTaskId` below is typed, not `unknown`. */
function isClaimUpsert(op: ClusterOp): op is ClusterOp & { fields: Record<string, unknown> } {
  if (op.op !== 'upsert' || !op.fields) return false;
  const value = op.fields['startedTaskId'];
  return typeof value === 'string' && value.length > 0;
}

/** The winner's claim state, as `HubOpOutcome.fields` for either verdict — D9a's whole point is
 *  that a LOSING claim still learns who holds it, and a winning one gets its `startedOn` echoed
 *  back (the spoke never proposes `startedOn` itself; see module docblock). */
function claimFields(row: Pick<StoredTodoRow, 'startedTaskId' | 'startedOn'>): Record<string, unknown> {
  const fields: Record<string, unknown> = { startedTaskId: row.startedTaskId };
  if (row.startedOn !== undefined) fields.startedOn = row.startedOn;
  return fields;
}

/**
 * Applies one op to the hub's own `todos.json` for `dataDir`'s project and reports the verdict
 * `cluster/hub-ops.ts#HubOpsDeps['applyOp']` needs. See the module docblock for the full reasoning;
 * this is the mechanical shape of it.
 */
export async function applyOpAtHub(dataDir: string, op: ClusterOp & { hubSeq: number }, options?: HubApplyOptions): Promise<HubOpOutcome> {
  if (op.entity !== 'todo') {
    // No store for this kind exists anywhere in the tree yet (module docblock, "never fabricate").
    // Thrown, not returned: hub-ops.ts leaves a gap and the spoke retries, which is correct — this
    // becomes applyable the day a `run`/`triage` store exists, and nothing here may claim otherwise
    // today.
    throw new Error(`cluster hub-apply: no store for entity "${op.entity}" yet (op ${op.opId})`);
  }

  return withTodosFileLease(dataDir, options, async () => {
    const rows = await readTodosRaw(dataDir);
    const idx = rows.findIndex((row) => row.id === op.entityId);
    const existing = idx >= 0 ? rows[idx] : undefined;

    const claiming = isClaimUpsert(op);

    if (claiming) {
      const proposed = op.fields.startedTaskId as string;
      // Truthiness, not `!== undefined`: `todoSchema` types `startedTaskId` as a bare
      // `z.string().optional()` with no `min(1)`, so `''` stores, and `todos.ts#markStartedWithClaim`
      // tests `if (item.startedTaskId)` — it reads `''` as UNCLAIMED and goes on to ask the hub. One
      // concept decided at two points: reading `''` as a HOLDER here would refuse every claim on
      // that row forever, naming a winner of `''`, for a value the rest of the system calls empty.
      if (existing?.startedTaskId && existing.startedTaskId !== proposed) {
        // D9a: another node's claim already won. Considered, durable, no write — `fields` carries
        // the WINNER's applied values so `todos.ts#markStartedWithClaim` can render who holds it.
        return { accepted: false, reason: 'already-started', fields: claimFields(existing) };
      }
    }

    // D4/D9: two frames racing on one entity can reach this lease in either order relative to
    // their hubSeq allocation. An op that is not strictly newer than what is already durably on
    // the record changes nothing — still a resolved, accepted verdict (matches
    // `cluster/replica.ts#applyReplica`'s own "skip, not re-apply" contract for the same case),
    // never a rejection. Runs AFTER the claim check on purpose — see module docblock.
    //
    // **A CLAIM never takes this exit at all** (`!claiming`), which is a stronger statement than
    // the ordering above and was added after the ordering alone proved insufficient. Ordering only
    // covers a claim that LOSES; it does nothing for a claim on a still-UNCLAIMED row whose hubSeq
    // an ordinary field op from another node has already carried past this claim's own. That op
    // would fall through to here and be answered `{ accepted: true }` without being written — and
    // `accepted` is the spoke's permission to START (`markStartedWithClaim`), so the hub would be
    // granting a run it holds no record of, and would grant the next node's claim the same way.
    // "Nothing to re-apply" is true of a field patch, whose value is already on the record; it is
    // never true of a claim, whose whole purpose is to BECOME the record.
    if (!claiming && existing?.hubSeq !== undefined && op.hubSeq <= existing.hubSeq) {
      return { accepted: true };
    }

    // `existing` is a real TodoItem whenever `idx >= 0` (schema-validated, with the id we just
    // matched on) — `storedTodoSchema`'s passthrough shape only differs from `TodoItem` in
    // widening `id` to optional, which this branch has already ruled out.
    const after = applyOpToRecord(existing as TodoItem | undefined, op);
    if (!after) {
      // `applyOpToRecord` never returns undefined for an upsert/tombstone (removal is compaction's
      // job elsewhere, per its own docblock) — asserted rather than silently written as a hole.
      throw new Error(`cluster hub-apply: applying op ${op.opId} produced no record for ${op.entityId}`);
    }

    // `applyOpToRecord` stamps `after.hubSeq = op.hubSeq` unconditionally. For an out-of-order
    // claim — the case exempted from the guard above — that would drag the record's hub order
    // BACKWARDS, and `cluster/ops.ts` reads that number to decide what is still unsent. The claim
    // is applied; the watermark is not regressed by it.
    if (existing?.hubSeq !== undefined && existing.hubSeq > op.hubSeq) after.hubSeq = existing.hubSeq;

    let outcomeFields: Record<string, unknown> | undefined;
    if (claiming) {
      // Not a clock read (module docblock): `startedOn` names the CLAIMING node, always the op's
      // own author — true whether this is a fresh claim or the winner resending its own claim
      // because an earlier ack never reached it.
      after.startedOn = op.nodeId;
      outcomeFields = claimFields(after);
    }

    const nextRows = rows.slice();
    if (idx >= 0) nextRows[idx] = after as StoredTodoRow;
    else nextRows.push(after as StoredTodoRow);
    await writeTodosRaw(dataDir, nextRows);

    return { accepted: true, ...(outcomeFields ? { fields: outcomeFields } : {}) };
  });
}

/** Builds the `HubOpsDeps['applyOp']` closure for one project's `dataDir` — the shape
 *  `hub-ops.ts`'s own docblock asks for ("construct the real one from a sibling package, closed
 *  over this frame's scope/projectKey, never here"). The caller (`hub-router.ts`'s `ops` case)
 *  resolves `projectKey` → `dataDir` itself; that mapping is outside this file's scope. */
export function createHubApplyOp(dataDir: string, options?: HubApplyOptions): HubOpsDeps['applyOp'] {
  return (op) => applyOpAtHub(dataDir, op, options);
}
