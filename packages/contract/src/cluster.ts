import { z } from 'zod';
import { hostMetricsResponseSchema } from './host-metrics.ts';
import { runIndexEntrySchema } from './runs.ts';
import { taskAuthorSchema } from './task-author.ts';
import { workflowDefSchema } from './workflows.ts';

/**
 * The CLUSTER family of `/api/v1`, and the node-to-node link protocol underneath it
 * (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, "Data models" + "API contracts";
 * dispatch plan `.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md`).
 *
 * One hub (`CEZ_CLUSTER=1`), N spokes (`CEZ_CLUSTER=1` + `CEZ_CLUSTER_HUB=<url>`) — D1, so hub-ness
 * is derived from configuration and cannot be configured into a contradiction. **The hub
 * linearizes every write** (D4): a spoke applies a mutation optimistically, marks the record
 * `pendingSince`, ships it as an op, and the hub's arrival order — `hubSeq`, the hub's own
 * monotonic counter — is the only order there is. There is no CRDT, no hybrid logical clock and no
 * last-writer-wins merge in this file, because the superseded D4 that needed them is gone.
 *
 * **Two schema disciplines live here, and mixing them up is the defect this header exists to
 * prevent** (spec → "HTTP invariants"):
 *
 *  - **Wire shapes are `.strict()`** — request bodies, responses, and every link frame. An unknown
 *    key is a protocol error, not a courtesy.
 *  - **On-disk shapes are `.passthrough()`** — `~/.cezar/cluster/*.json`, `.ai/cezar/cluster/
 *    ops.ndjson`, and the six additive todo fields. `storedX` is always the open half; the
 *    unprefixed name is always the closed one. Where both exist they are built from ONE shape
 *    object (`…Shape` below) so the pair cannot drift field-by-field.
 *
 * **How `.strict()` coexists with D13** ("an op a node does not understand is stored and re-emitted,
 * never dropped"). The extension point is the payload, never the envelope: `ClusterOp.fields` and
 * `ClusterOp.unknown` are `Record<string, unknown>` and therefore open by construction, and
 * `ClusterRemoteRun` carries the same `unknown` bag for the same reason. So a newer node's extra
 * RECORD content survives an older node verbatim, while a new *envelope* key is a protocol change
 * that an older node will reject — which is why adding one needs a `protocol.minor` bump and the
 * same care as a major. Per-entry salvage (`cluster/ops.ts`) keeps one unparseable entry from
 * evicting its siblings; a `protocol.major` mismatch refuses the whole link, with the reason named,
 * because a partial apply that looks complete is the worse failure.
 *
 * **Node-free, like every file in this package** (its tsconfig sets `types: []`, so a `node:*`
 * import is a compile error rather than a convention). This file holds shapes only: the HMAC that
 * signs a link frame, the SHA-256 that digests an enrollment code, and every filesystem path live
 * in `packages/cezar/src/cluster/`, never here.
 *
 * **Flag-off shape: `/api/v1/cluster*` answers `409` with a stated reason while `CEZ_CLUSTER` is
 * unset.** The routes stay chained into `AppType` (a loose `app.get` would vanish from the typed
 * client) behind a guard registered against EXPLICIT paths — `/cluster` and `/cluster/*`, never
 * `use('*')`, which would gate the whole `/api/v1` surface including `/health`, for the reason
 * `requireAutomations` spells out at `server/server.ts:4511`. `capabilities.cluster`
 * (`./health.ts`), always present and `false` when off, is how the cockpit knows not to ask.
 *
 * **CORRECTED 2026-08-22, during implementation — it took two wrong answers to get here, and both
 * are recorded because each was defended with a real argument.** Spec Verification 12 carries the
 * same history.
 *
 *  1. ~~200 with `enabled: false`, every mutator 409, never a 404, matching `./sources.ts`'s own
 *     flag-off contract.~~ Wrong: that shape exists because the **Sources section is always
 *     rendered** and needs a schema-valid body to draw "not configured" with. A cluster that is off
 *     has no nav item, no section and no caller, so a 200 would be **inventing a reader**. This is
 *     why `clusterOverviewResponseSchema` carries no `enabled` field — see its own note below.
 *  2. ~~404, since Verification 12 said `/api/v1/cluster*` → 404 and Architecture said "no
 *     route".~~ Also wrong, and the closest precedent settles it: **automations** is a feature with
 *     *no* settings section at all when off — the same "no surface, no caller" property that killed
 *     answer 1 — and `server.ts` answers `409 AUTOMATIONS_OFF` for **every route of the family**.
 *
 * The deciding argument is one neither draft made: **404 already means something else here.**
 * `sources-routes.ts` returns 404 for `UNKNOWN_CONNECTION` in a dozen places, and this family will
 * need exactly that answer too — `DELETE /cluster/nodes/:nodeId` on an id that does not exist. A
 * flag-off 404 would be indistinguishable from an unknown node id **on the same route**, in a
 * design whose whole premise is that a refusal names itself. That is the same reason enrollment has
 * five named failure values instead of one generic error.
 *
 * **One 404 does survive, and it is not this one:** the cockpit's own `/settings/cluster` route,
 * dropped client-side by the settings registry's `capability` gate. Asserting only the absent nav
 * item would pass against a reachable orphan route, which is why Verification 12 asks for both.
 */

// ---- protocol, and the bounds that are part of it ---------------------------------------------

/**
 * Bumped MAJOR only for a change an older node cannot safely half-apply — a new envelope key, a
 * removed frame, a changed meaning. A MINOR bump is additive payload only. A major mismatch
 * REFUSES the link with `protocol-major` and shows it in the cockpit (D13).
 */
export const CLUSTER_PROTOCOL_MAJOR = 1;
export const CLUSTER_PROTOCOL_MINOR = 0;

export const clusterProtocolSchema = z
  .object({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
  })
  .strict();
export type ClusterProtocol = z.infer<typeof clusterProtocolSchema>;

export const CLUSTER_PROTOCOL: ClusterProtocol = {
  major: CLUSTER_PROTOCOL_MAJOR,
  minor: CLUSTER_PROTOCOL_MINOR,
};

/**
 * Bounds are part of the contract, not an implementation detail — the same posture `server/ws.ts`
 * takes with its 4 KB cap on cockpit control frames. These carry payload rather than control, so
 * they get their own, larger, STATED bound: a sender that would exceed either splits and resumes
 * from the last `ack`, so a dropped frame costs a retransmit and never a gap.
 */
export const CLUSTER_FRAME_MAX_BYTES = 256 * 1024;
export const CLUSTER_OPS_PER_FRAME_MAX = 500;

/** The one link path. Node auth ONLY — `server/ws.ts`'s guard admits browser origins and must not
 *  admit a node, and a node-authenticated socket must never gain cockpit topics. */
export const CLUSTER_LINK_PATH = '/api/v1/cluster/link';

// ---- vocabulary --------------------------------------------------------------------------------

/** uuid v4 in practice (`node-identity.ts` mints it), deliberately not pinned to a uuid validator:
 *  a peer whose id shape we disagree with would have its whole frame dropped, and the shape of an
 *  id is not a safety property. Bounded, not parsed. */
export const clusterNodeIdSchema = z.string().min(1).max(64);
export type ClusterNodeId = z.infer<typeof clusterNodeIdSchema>;

export const clusterNodeNameSchema = z.string().min(1).max(120);

export const clusterNodeRoleSchema = z.enum(['hub', 'spoke']);
export type ClusterNodeRole = z.infer<typeof clusterNodeRoleSchema>;

/**
 * DISCOVERED, never configured (D12) — `macos`, `imessage`, `browser`, `device-e2e`, `cgroup`, and
 * whichever agent CLIs are logged in. A plain bounded string rather than a literal union, for the
 * reason `sourceKindSchema` states in `./sources.ts`: a union here is the `ForgeKind` mistake, and
 * a probe that learns a new capability must not need a contract change to report it.
 */
export const clusterNodeLabelSchema = z.string().min(1).max(32);
export type ClusterNodeLabel = z.infer<typeof clusterNodeLabelSchema>;

/** The minted per-project identity (D2), paired across nodes and inert until a human confirms it.
 *  Bounded, not parsed — same reasoning as `clusterNodeIdSchema`. */
export const clusterProjectKeySchema = z.string().min(1).max(64);
export type ClusterProjectKey = z.infer<typeof clusterProjectKeySchema>;

/** The hub's own monotonic counter (D4). Not a clock, not a lamport pair — a spoke resumes from a
 *  number it did not invent, which is the whole of the ordering design. */
export const clusterHubSeqSchema = z.number().int().nonnegative();

// ---- capacity, freshness, corpus: what a node claims about itself ------------------------------

/**
 * Which mechanism actually enforces the per-run ceiling on this node (D14a). `cgroup` on Linux,
 * `process-tree` on macOS where cgroups do not exist, `none` where neither is available. Reported
 * rather than assumed, and rendered as a stated limitation, because a limit that silently does not
 * exist on one node is worse than one that was never claimed.
 */
export const clusterCapacityEnforcementSchema = z.enum(['cgroup', 'process-tree', 'none']);
export type ClusterCapacityEnforcement = z.infer<typeof clusterCapacityEnforcementSchema>;

/**
 * Two numbers per node, not one (D14) — `maxParallel` bounds what is admitted at all, and
 * `maxHeavySteps` bounds how many are inside a CPU/memory-heavy step at once. One count cannot
 * express a bimodal workload. Neither is a cluster-wide cap: the cluster target is reached by
 * placement filling nodes up to their OWN advertised limits, never by a shared semaphore that would
 * put a 58 ms round trip in front of every admission decision.
 */
export const clusterCapacitySchema = z
  .object({
    maxParallel: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    /** Absent = unbounded, i.e. the behaviour of every cezar that predates D14. */
    maxHeavySteps: z.number().int().nonnegative().optional(),
    heavyActive: z.number().int().nonnegative(),
    enforcement: clusterCapacityEnforcementSchema,
  })
  .strict();
export type ClusterCapacity = z.infer<typeof clusterCapacitySchema>;

/**
 * One paired project's checkout, as the node holding it reports it — the `freshness` frame's
 * payload and, verbatim, one row of `presence.repoDrift[]`. One shape, because the pre-dispatch
 * question and the health panel's column are the same question asked at two cadences.
 *
 * `merging` is the field the record has already paid for: the box's own `chat` checkout sat six
 * hours mid-conflict showing one ordinary dirty file while every pull silently failed. A push is
 * not delivery, and `dirty: 1` alone never said so.
 */
export const clusterRepoFreshnessSchema = z
  .object({
    projectKey: clusterProjectKeySchema,
    headSha: z.string().min(1).max(64),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    dirty: z.number().int().nonnegative(),
    /** `MERGE_HEAD` present. Never inferred from `dirty`. */
    merging: z.boolean(),
  })
  .strict();
export type ClusterRepoFreshness = z.infer<typeof clusterRepoFreshnessSchema>;

/**
 * One top-level corpus directory a node mirrors (D8a). A bounded string, not a union, for the same
 * reason as `clusterNodeLabelSchema` — the corpus's shape is data.
 *
 * `reports/` and `raw-input/` are opt-in per node and OFF by default: 196 files carrying phone
 * numbers and chat ids have no business on a machine whose whole premise is that it is disposable.
 */
export const clusterCorpusScopeSchema = z.string().min(1).max(64);

export const CLUSTER_CORPUS_DEFAULT_SCOPE = ['knowledge', 'domains', 'changelog', 'tasks'] as const;
export const CLUSTER_CORPUS_OPT_IN_SCOPE = ['reports', 'raw-input'] as const;

/**
 * A mirror's own freshness, carried on every `presence` frame — because **a stale mirror must be
 * loud** (D8a): a wrong commit throws, but a corpus four hours behind just returns an older answer,
 * confidently. `scope` is rendered too, so "not found" is never ambiguous between *absent from the
 * record* and *not mirrored here*.
 */
export const clusterCorpusStatusSchema = z
  .object({
    /** The hub's corpus version this mirror last fetched — the hub's number, not the spoke's. */
    version: z.string().min(1).max(120),
    fetchedAt: z.string(),
    scope: z.array(clusterCorpusScopeSchema).max(32),
    /** Documents the sweep refused to overwrite because the local body had diverged. The local
     *  body is left byte-identical; silently overwriting would destroy evidence of a write. */
    quarantined: z.number().int().nonnegative(),
  })
  .strict();
export type ClusterCorpusStatus = z.infer<typeof clusterCorpusStatusSchema>;

// ---- the roster: one node, wire and stored ------------------------------------------------------

/**
 * Shared by the closed roster row and the open `peers.json` entry. A node's advertised capacity is
 * **a claim, stamped with when it was made** — `capacityAt` exists so the cockpit can render its
 * age rather than presenting a sleeping laptop's last boast as current fact.
 */
const clusterNodeShape = {
  nodeId: clusterNodeIdSchema,
  nodeName: clusterNodeNameSchema,
  role: clusterNodeRoleSchema,
  labels: z.array(clusterNodeLabelSchema).max(64),
  /** Absent until the node has linked once. Its age is what "asleep since HH:MM" is rendered from
   *  — a state, not a red error. */
  lastSeenAt: z.string().optional(),
  /** D11: stored on BOTH sides, and the spoke re-enforces it regardless of what the hub sends.
   *  Default off — a newly enrolled node replicates state and runs nothing. */
  acceptsDispatch: z.boolean(),
  protocol: clusterProtocolSchema,
  /** The cezar version this node runs. Skew is permanent (D13), so it is reported, not required. */
  version: z.string().max(64),
  capacity: clusterCapacitySchema.optional(),
  /** When `capacity` was claimed. Rendered beside it, always. */
  capacityAt: z.string().optional(),
  hostMetrics: hostMetricsResponseSchema.optional(),
  repoDrift: z.array(clusterRepoFreshnessSchema).max(200).optional(),
  corpus: clusterCorpusStatusSchema.optional(),
  /** Set by a hub-side revoke. Revocation is two-sided (spec → "Security and blast radius" 5): the
   *  spoke's credential is deleted too, because a hub-side revoke alone does not stop a spoke from
   *  continuing to push ops. */
  disabledAt: z.string().optional(),
} as const;

export const clusterNodeSchema = z.object(clusterNodeShape).strict();
export type ClusterNode = z.infer<typeof clusterNodeSchema>;

export const storedClusterNodeSchema = z.object(clusterNodeShape).passthrough();
export type StoredClusterNode = z.infer<typeof storedClusterNodeSchema>;

// ---- pairings (D2) -------------------------------------------------------------------------------

/** Which signal proposed a pairing. Never auto-confirmed on either one: a wrong pairing writes
 *  another repo's backlog into your repo, so this fails closed and an unpaired project replicates
 *  nothing. `origin` additionally requires `git rev-parse --git-common-dir` to be the project's own,
 *  so a worktree can never pose as its parent repo. */
export const clusterPairingSignalSchema = z.enum(['origin', 'slug-and-basename']);
export type ClusterPairingSignal = z.infer<typeof clusterPairingSignalSchema>;

const clusterPairingMemberShape = {
  nodeId: clusterNodeIdSchema,
  /** The registry id this project has ON THAT NODE — local, and different per node by design. */
  projectId: z.string().min(1).max(200),
  /** Present once a human confirmed it in the cockpit. Absent = proposed, inert, replicates nothing. */
  confirmedAt: z.string().optional(),
} as const;

export const clusterPairingMemberSchema = z.object(clusterPairingMemberShape).strict();
export type ClusterPairingMember = z.infer<typeof clusterPairingMemberSchema>;

const clusterPairingShape = {
  projectKey: clusterProjectKeySchema,
  byNode: z.record(clusterNodeIdSchema, z.object(clusterPairingMemberShape).passthrough()),
} as const;

export const clusterPairingSchema = z
  .object({
    projectKey: clusterProjectKeySchema,
    byNode: z.record(clusterNodeIdSchema, clusterPairingMemberSchema),
  })
  .strict();
export type ClusterPairing = z.infer<typeof clusterPairingSchema>;

export const storedClusterPairingSchema = z.object(clusterPairingShape).passthrough();
export type StoredClusterPairing = z.infer<typeof storedClusterPairingSchema>;

/** What a spoke advertises about one project on `hello` — the inputs D2's proposal is computed
 *  from, plus the one eligibility fact placement cannot work without. A spoke advertises ONLY
 *  projects it has confirmed (spec → "Security and blast radius" 6). */
export const clusterProjectAdvertSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    /** Minted on first cluster boot; absent on a project this node has not keyed yet. */
    projectKey: clusterProjectKeySchema.optional(),
    slug: z.string().min(1).max(200),
    basename: z.string().min(1).max(200),
    /** Normalized `git remote get-url origin`. Absent means the project HAS no origin, which is a
     *  placement fact, not a missing field: its durable output would live only on this node's disk,
     *  so it may only ever run here (D12). */
    originUrl: z.string().max(500).optional(),
    /** False when `git rev-parse --git-common-dir` points outside this project — a worktree. The
     *  `origin` signal is not admissible for one. */
    ownGitCommonDir: z.boolean(),
  })
  .strict();
export type ClusterProjectAdvert = z.infer<typeof clusterProjectAdvertSchema>;

/** A proposal the hub computed and nobody has confirmed. Rendered as "not paired" until someone
 *  does. */
export const clusterPairingProposalSchema = z
  .object({
    projectKey: clusterProjectKeySchema,
    signal: clusterPairingSignalSchema,
    members: z.array(clusterPairingMemberSchema).max(64),
    proposedAt: z.string(),
  })
  .strict();
export type ClusterPairingProposal = z.infer<typeof clusterPairingProposalSchema>;

// ---- ops: the only thing a spoke ever writes upward (D4, D5, D13) ------------------------------

export const clusterOpScopeSchema = z.enum(['project', 'workspace']);
export type ClusterOpScope = z.infer<typeof clusterOpScopeSchema>;

export const clusterOpEntitySchema = z.enum(['todo', 'run', 'triage']);
export type ClusterOpEntity = z.infer<typeof clusterOpEntitySchema>;

/** A delete is a `tombstone`, never a removal (D6): a bare removal loses to any concurrent patch
 *  and the row resurrects. Tombstones are compacted after the retention window, never before. */
export const clusterOpKindSchema = z.enum(['upsert', 'tombstone']);
export type ClusterOpKind = z.infer<typeof clusterOpKindSchema>;

const clusterOpShape = {
  opId: z.string().min(1).max(64),
  /** The node that AUTHORED the op. Not a tiebreak and not an ordering input — the hub decides
   *  order — but the attribution a correction is rendered with. */
  nodeId: clusterNodeIdSchema,
  ts: z.string(),
  scope: clusterOpScopeSchema,
  projectKey: clusterProjectKeySchema.optional(),
  entity: clusterOpEntitySchema,
  entityId: z.string().min(1).max(200),
  op: clusterOpKindSchema,
  /**
   * **ONLY what changed** (D4). Per-field granularity survives the death of the CRDT as the shape
   * of an op rather than as merge semantics: two spokes that queued edits to DIFFERENT fields of
   * one todo while partitioned both land, because the hub applies them in sequence. Had ops carried
   * whole records, the second would clobber the first.
   */
  fields: z.record(z.string(), z.unknown()).optional(),
  /**
   * **The other half of "only what changed"** (2026-08-22 amendment). `fields` can only express a
   * key being SET — `Object.assign` has no way to remove a key, so a field a spoke deleted locally
   * (`updateTodo({ archived: false })`, `clearStartedTaskId`, `markStarted`'s `delete autostart`)
   * was simply absent from every op, and the deletion never reached any other node. `null` is not
   * used for this on `fields` because `null` is a legitimate value for a passthrough field —
   * overloading it would make "set to null" and "delete" indistinguishable, the same conflation
   * `pendingFields` exists to remove one layer up. A key is never named in both `fields` and
   * `clearedFields` on the same op — see `cluster/ops.ts`'s derivation and `compactOps`'s collapse
   * for how that invariant is kept. Bounded like `pendingFields`, which is where these names come
   * from.
   */
  clearedFields: z.array(z.string().min(1).max(120)).max(32).optional(),
  /** D13's escape hatch, and the reason a `.strict()` envelope is safe here: fields a node does not
   *  understand ride verbatim and are re-emitted, never dropped. Without it the OLDEST node in the
   *  cluster silently truncates everyone's history. */
  unknown: z.record(z.string(), z.unknown()).optional(),
  /** Assigned by the hub on apply; absent on an op that has not reached the hub yet. */
  hubSeq: clusterHubSeqSchema.optional(),
} as const;

export const clusterOpSchema = z.object(clusterOpShape).strict();
export type ClusterOp = z.infer<typeof clusterOpSchema>;

/** `.ai/cezar/cluster/ops.ndjson` — the DERIVED outbox, one op per line. The log is a cache, never
 *  the truth: a crash that loses the tail loses nothing, because the outbox is re-derivable from
 *  the records still marked `pendingSince` (D5). */
export const storedClusterOpSchema = z.object(clusterOpShape).passthrough();
export type StoredClusterOp = z.infer<typeof storedClusterOpSchema>;

/**
 * What the hub decided differently from the optimistic local value (D4): "the replica push corrects
 * it and the cockpit SHOWS that it changed, rather than silently swapping the value under the
 * reader." A correction nobody sees is the same failure as no correction.
 */
export const clusterReplicaCorrectionSchema = z
  .object({
    entity: clusterOpEntitySchema,
    entityId: z.string().min(1).max(200),
    field: z.string().min(1).max(120),
    localValue: z.unknown().optional(),
    hubValue: z.unknown().optional(),
    hubSeq: clusterHubSeqSchema,
    at: z.string(),
  })
  .strict();
export type ClusterReplicaCorrection = z.infer<typeof clusterReplicaCorrectionSchema>;

// ---- watermarks ---------------------------------------------------------------------------------

const clusterWatermarkShape = {
  scope: clusterOpScopeSchema,
  projectKey: clusterProjectKeySchema.optional(),
  /** The last hub order this node has APPLIED to its own replica. Resume, never replay from zero. */
  appliedThroughHubSeq: clusterHubSeqSchema,
  /** The last hub order the hub has ACKNOWLEDGED for this node's own outbox. Everything above it is
   *  still owed and gets re-sent — which is why a dropped frame costs a retransmit, never a gap. */
  ackedThroughHubSeq: clusterHubSeqSchema,
  updatedAt: z.string().optional(),
} as const;

export const clusterWatermarkSchema = z.object(clusterWatermarkShape).strict();
export type ClusterWatermark = z.infer<typeof clusterWatermarkSchema>;

export const storedClusterWatermarkSchema = z.object(clusterWatermarkShape).passthrough();
export type StoredClusterWatermark = z.infer<typeof storedClusterWatermarkSchema>;

// ---- the six additive todo fields (on-disk, `.passthrough()`) ----------------------------------

/**
 * Additive and optional on `todoSchema`, all six — an existing entry with none of them still
 * validates, the same contract every field added since 2026-08-15 has kept.
 *
 * Package 2.0 merges this into `packages/cezar/src/todos.ts`'s own schema
 * (`todoSchema.extend(clusterTodoFieldsSchema.shape)`).
 *
 * **CORRECTED 2026-08-23 — the second extension has landed, and it is deliberately PARTIAL.** This
 * paragraph used to end "the COCKPIT-facing todo shape (`./skills.ts`'s `todoItemSchema`) is not
 * extended here and does not yet carry them", which was true when written and is now false in a
 * way that matters: a reader taking it at face value would re-add fields that are already there,
 * or assume none of the six reach the board. `todoItemSchema` now carries exactly **two** —
 * `placement` and `startedOn`, the only two anything renders — and deliberately not the other
 * four, which are sync bookkeeping and belong to the on-disk shape alone. The reason the split
 * had to be made explicit at all is unchanged and still the point: a plain `z.object` **strips**
 * what it does not declare, so an unextended cockpit shape shows an unpinned, unstarted todo for
 * one that is pinned and running on another node — silently, and found late.
 */
export const clusterTodoPlacementShape = {
  /** Pins. Resolution order is: explicit `node` → `requires` narrows → most headroom (D12). */
  node: clusterNodeIdSchema.optional(),
  requires: z.array(clusterNodeLabelSchema).max(16).optional(),
} as const;

export const clusterTodoPlacementSchema = z.object(clusterTodoPlacementShape).strict();
export type ClusterTodoPlacement = z.infer<typeof clusterTodoPlacementSchema>;

export const storedClusterTodoPlacementSchema = z.object(clusterTodoPlacementShape).passthrough();

export const storedClusterTombstoneSchema = z.object({ at: z.string() }).passthrough();

export const clusterTodoFieldsSchema = z
  .object({
    /** Set on an optimistic local write, INSIDE the same `O_EXCL` lease as the value, and cleared
     *  on the hub's ack. Marker and value can therefore never disagree — which is what makes the
     *  outbox re-derivable and a lost tail harmless (D5). */
    pendingSince: z.string().optional(),
    /** WHICH keys `pendingSince` covers (AMENDED 2026-08-22 — see the spec's Data Models section).
     *  `pendingSince` alone says only THAT a record is owed, never what changed, so a
     *  derive-from-records outbox (D5) had nothing to narrow on and could only send the whole
     *  record — the exact whole-record clobber D4 exists to prevent. Written inside the SAME
     *  lease as `pendingSince`; unioned, never replaced, while a cycle is outstanding; reset to
     *  just the new edit on the next cycle rather than carried forward (`todos.ts#stampPending`).
     *  Bounded like the todo schema's own field count, not open-ended. */
    pendingFields: z.array(z.string().min(1).max(120)).max(32).optional(),
    /** The last hub order this record was confirmed at. */
    hubSeq: clusterHubSeqSchema.optional(),
    tombstone: storedClusterTombstoneSchema.optional(),
    placement: storedClusterTodoPlacementSchema.optional(),
    /** The node this todo's run was claimed on. **Hub-confirmed only, never optimistic** (D4/D9a):
     *  the one write that waits, because an optimistic local start on a partitioned spoke is
     *  exactly the double-start this design exists to prevent. */
    startedOn: clusterNodeIdSchema.optional(),
  })
  .passthrough();
export type ClusterTodoFields = z.infer<typeof clusterTodoFieldsSchema>;

// ---- the foreign-run projection (D9, D10) --------------------------------------------------------

/**
 * A run on another node, as this node's board renders it — `~/.cezar/cluster/runs-remote.json` and
 * the union into the workspace runs list.
 *
 * Built on `runIndexEntrySchema` deliberately: it is already the cross-project board's row, so a
 * foreign run needs no second render path. **No `worktreePath`, no local paths, no local-machine
 * affordance** — the hub runs hosted (`CEZ_REMOTE=1`) where `localHandoff` is already false, and
 * the cluster must not become a way to smuggle "open in terminal" for a run on somebody else's
 * host. Nothing may be added here that would let a foreign run request one.
 *
 * `unreachable` is a separate optional field beside `status`, **never a new `RunStatus`** (D10):
 * `RunStatus` ships in `@loki-labs/better-cezar` and a published wire enum is never widened
 * (PLAN P8) — the same reason a budget stop is `review` + `stopReason`.
 */
export const clusterRemoteRunSchema = runIndexEntrySchema
  .extend({
    nodeId: clusterNodeIdSchema,
    projectKey: clusterProjectKeySchema.optional(),
    /** The owning node went away mid-run. A run never migrates (D10) — sessions, worktrees and
     *  broker scopes are node-local, so this is a statement about visibility, not about the run. */
    unreachable: z.boolean().optional(),
    unreachableSince: z.string().optional(),
    /** D13, as on `ClusterOp`: a field a newer node projected and this one cannot place rides here
     *  rather than failing the row. */
    unknown: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ClusterRemoteRun = z.infer<typeof clusterRemoteRunSchema>;

/**
 * One in-flight run as `GET /api/v1/cluster/active` and `cez cluster active` report it — D19 rung 4,
 * "let an agent read what else is in flight", and the input rung 3's overlap refusal is computed
 * from.
 *
 * **`summary` is agent- or human-authored text read by another agent, and therefore an injection
 * surface** (D19's closing rule). A consumer frames it as an attributed report — *"run `r_123` on
 * `worker-2` reported: …"* — and never merges it into a system prompt, never lets it grant a
 * capability, name a tool or widen an allowlist. It is bounded here; that is necessary and not
 * sufficient.
 */
export const clusterActiveRunSchema = z
  .object({
    runId: z.string().min(1).max(120),
    nodeId: clusterNodeIdSchema,
    projectKey: clusterProjectKeySchema.optional(),
    todoId: z.string().max(200).optional(),
    summary: z.string().max(500).optional(),
    branch: z.string().max(200).optional(),
    /** REPO-RELATIVE, from `collectChanges` on the owning node — one git call at dispatch. Never
     *  absolute: an absolute path is a local-machine fact and has no meaning on the reader's host. */
    paths: z.array(z.string().max(400)).max(500),
    startedAt: z.string().optional(),
  })
  .strict();
export type ClusterActiveRun = z.infer<typeof clusterActiveRunSchema>;

export const clusterActiveResponseSchema = z
  .object({
    runs: z.array(clusterActiveRunSchema),
    /**
     * The most recent time this hub heard from any of its linked roster nodes
     * (`StoredClusterNode#lastSeenAt`, stamped for real by `markNodeSeen` on every presence
     * heartbeat) — **absent when no linked node has ever reported, including an empty roster.**
     * Exists so a caller can tell "nothing is running" from "nobody has reported recently": an
     * absent `asOf` means `runs` is not evidence of anything, whatever it contains.
     *
     * **CORRECTED 2026-08-23 — this used to be `z.string()`, unconditionally filled by both call
     * sites (`cluster-routes.ts`, `index.ts`) with `new Date().toISOString()`.** That is
     * wall-clock-now, not a fact about any node, so the one field this type carries specifically
     * to expose staleness was permanently fresh regardless of whether anything had ever reported
     * — an untracked cluster and a tracked-but-idle one were byte-identical. Optionality is the
     * fix: absence IS the "nothing tracked" signal, so there is no need for a second discriminator
     * field alongside it.
     */
    asOf: z.string().optional(),
  })
  .strict();
export type ClusterActiveResponse = z.infer<typeof clusterActiveResponseSchema>;

// ---- placement (D12, D19 rung 3) ------------------------------------------------------------------

/**
 * FOUR distinct values, and collapsing them into "queued" is what sends a person to buy a node when
 * the real fix was opening a laptop lid. They look identical from the board and are not:
 *
 *  - `no-node-accepts-dispatch` — nobody has opted in. D11 defaults `acceptsDispatch` to OFF on
 *    every node, so this is the state a freshly clustered pair sits in until an operator runs
 *    `cez cluster accept-dispatch --on`. It is reported separately BECAUSE the honest answer is
 *    not "everyone is full": saying `all-eligible-at-capacity` on a completely idle cluster sends
 *    whoever reads the board to look at load, which is the one place the cause is not;
 *  - `no-node-with-label` — no node carries the label `requires` asked for;
 *  - `all-eligible-at-capacity` — every eligible node is full;
 *  - `pinned-node-offline` — the node it needs is asleep or revoked;
 *  - `project-has-no-origin` — the project's durable output would live only on one node's disk, so
 *    it may only run where it lives (D12). Four of the box's twelve registered projects are in this
 *    state, so it is a live case, not a hypothetical.
 */
export const clusterQueuedReasonSchema = z.enum([
  'no-node-accepts-dispatch',
  'no-node-with-label',
  'all-eligible-at-capacity',
  'pinned-node-offline',
  'project-has-no-origin',
]);
export type ClusterQueuedReason = z.infer<typeof clusterQueuedReasonSchema>;

/**
 * What placement decided. `blocked` is D19 rung 3 and deliberately NOT a fifth queued reason: the
 * other run is *named*, with its node, branch and touched paths, because "queued" without the
 * conflicting run is a dead end for whoever reads the board. It catches the collision before the
 * work is wasted rather than at push time, costs no tokens, and is deterministic.
 */
export const clusterPlacementResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('placed'), nodeId: clusterNodeIdSchema }).strict(),
  z
    .object({
      status: z.literal('queued'),
      reason: clusterQueuedReasonSchema,
      /** The label or node the requirement named, so the render can be specific rather than
       *  generic. Never prose the UI has to parse. */
      detail: z.string().max(200).optional(),
    })
    .strict(),
  z.object({ status: z.literal('blocked'), blockedBy: clusterActiveRunSchema }).strict(),
]);
export type ClusterPlacementResult = z.infer<typeof clusterPlacementResultSchema>;

// ---- enrollment (D17) -----------------------------------------------------------------------------

/**
 * **Values, not prose** — an operator who cannot tell an Access rejection from a stale code will
 * re-mint codes to fix a credential problem. Enrollment answers TWO independent gates (the
 * Cloudflare Access credential, supplied from the operator's environment, and the single-use code)
 * and must always say which one refused it. Every member carries a `message` alongside it, but the
 * message is for the human and the VALUE is the triage: no member may be chosen because its prose
 * can be written to read correctly.
 *
 * **`code-malformed` is emitted by the JOINING node and never by the hub** (added 2026-08-22 during
 * implementation). `joinCluster` parses the pasted code before it dials anything, so a typo fails
 * with no request sent, no socket opened and no hub contacted. It was first written as
 * `hub-unreachable` on the argument that the two read alike to an operator — which is the prose
 * argument this docblock exists to refuse, and it is worse than merely imprecise: `hub-unreachable`
 * asserts a tested fact about DNS, the tunnel and Access, none of which was tested, sending the
 * operator to audit three healthy subsystems when the fix is to re-paste the code. Do not add a
 * hub-side branch that emits it, and do not write a server test expecting it.
 *
 * **The split rule, so the next member is not argued from taste:** two failures get two values
 * when the operator *holding the screen* can do something different about them, and one value when
 * they cannot. That is why a malformed code is its own member (only that operator can fix it, by
 * re-pasting) and why a hub that answers HTTP 500 stays `hub-unreachable` (the joiner's next move
 * is identical to a hub that is down — retry, or go ask whoever runs the hub); the `message` names
 * the status so nobody is sent to audit their own network for it.
 *
 * **Two folds here are deliberate; neither is a missing member.**
 *  - A code the hub never minted answers `code-expired`, not a `code-not-found`. Distinguishing
 *    them would turn enrollment into an oracle for whether a given code was ever real, which is
 *    exactly what an attacker probing minted codes wants. The fold is the security property.
 *  - A revoked code also answers `code-expired`, for the same reason: the joining node is the
 *    untrusted side of this exchange and learns only that this code will not work. The hub keeps
 *    the distinction where it belongs — its own enrollment record carries the revocation, so the
 *    operator who revoked it sees a revocation and the stranger holding it does not.
 */
export const clusterJoinFailureReasonSchema = z.enum([
  'access-rejected',
  'code-expired',
  'code-malformed',
  'code-used',
  'hub-unreachable',
  'protocol-major',
]);
export type ClusterJoinFailureReason = z.infer<typeof clusterJoinFailureReasonSchema>;

/**
 * Rendered SERVER-SIDE by the hub, pinning the hub's OWN version into the `npx` spec rather than
 * `@latest` (D13: protocol skew is permanent, so a node should start life matched to the hub that
 * minted it). Never assembled client-side.
 *
 * The rule that constrains what may appear in these strings: a command rendered in a UI is
 * screenshotted, pasted into chat, and left in the shell history of a machine we may not own — so
 * only the single-use, short-TTL, digest-at-rest code goes in it, and **never the Access client id
 * or secret**. And it is `npx`, not `curl … | sh`: every path on `cockpit.example.com` 302s to the
 * Access login, so a piped installer would feed an HTML login page to a shell.
 */
export const clusterEnrollCommandsSchema = z
  .object({
    /** Enroll an existing cezar install as a spoke. */
    join: z.string().min(1).max(2_000),
    /** Provision a fresh worker box and enroll it (Phase 4's worker role). */
    provision: z.string().min(1).max(2_000),
  })
  .strict();
export type ClusterEnrollCommands = z.infer<typeof clusterEnrollCommandsSchema>;

export const clusterEnrollRequestSchema = z
  .object({
    /** A display name for the node-to-be. Cosmetic; the node may rename itself later. */
    nodeName: clusterNodeNameSchema.optional(),
    ttlSeconds: z.number().int().min(60).max(86_400).optional(),
  })
  .strict();
export type ClusterEnrollRequest = z.infer<typeof clusterEnrollRequestSchema>;

export const clusterEnrollResponseSchema = z
  .object({
    /** Addresses the code for revoke-before-use. Not the code, and not derived from it. */
    codeId: z.string().min(1).max(64),
    /** The `cezj_` token — hub URL and code packed into one opaque string. Returned ONCE, at mint;
     *  the hub stores only its SHA-256 digest and can never show it again. */
    code: z.string().min(1).max(512),
    expiresAt: z.string(),
    commands: clusterEnrollCommandsSchema,
  })
  .strict();
export type ClusterEnrollResponse = z.infer<typeof clusterEnrollResponseSchema>;

export const clusterEnrollRevokeResponseSchema = z.object({ revoked: z.boolean() }).strict();
export type ClusterEnrollRevokeResponse = z.infer<typeof clusterEnrollRevokeResponseSchema>;

/**
 * `DELETE /api/v1/cluster/enroll/:codeId`, validated as middleware through `server/validators.ts`.
 *
 * **CORRECTED 2026-08-23 — what a param schema buys is NOT what this comment first claimed.** It
 * said the middleware discipline exists because "parsing inside the handler is invisible to hono,
 * which is what let `POST /runs` accept `{ totalNonsense: 12345 }` from a typed client". That is a
 * fact about **request BODIES** and does not transfer to params. Measured by package 1.0 on
 * 2026-08-23: deleting `paramZodValidator` from this route and from `PATCH /cluster/nodes/:nodeId`
 * left `tsc --noEmit -p tsconfig.test.json` **completely clean**, because hono derives the `param`
 * shape from the path PATTERN, whereas `json`'s shape exists only if a validator declared it.
 *
 * So there is no compile-time guard that the validator is present, and nobody should believe there
 * is. What the schema actually buys, both of which are worth having:
 *
 *  - **A runtime bound** — `PATCH /cluster/nodes/<65 chars>` answers 400 instead of reaching the
 *    store. Covered by a runtime case with a negative control: remove the validator and the same
 *    request answers 404 `unknown node`, with the compile-time half green either way.
 *  - **Agreement between this schema and the route's segment**, which `contract-parity.cluster.
 *    test.ts` does catch — a renamed or reshaped param fails there.
 */
export const clusterCodeIdParamSchema = z
  .object({ codeId: z.string().min(1).max(64) })
  .strict();
export type ClusterCodeIdParam = z.infer<typeof clusterCodeIdParamSchema>;

export const clusterJoinRequestSchema = z
  .object({
    code: z.string().min(1).max(512),
    nodeId: clusterNodeIdSchema,
    nodeName: clusterNodeNameSchema,
    labels: z.array(clusterNodeLabelSchema).max(64),
    protocol: clusterProtocolSchema,
    version: z.string().max(64),
  })
  .strict();
export type ClusterJoinRequest = z.infer<typeof clusterJoinRequestSchema>;

/**
 * The one response in this contract that carries a durable credential — which is exactly why the
 * code that buys it is single-use and short-TTL, and why the CLI writes `secret` to
 * `~/.cezar/cluster/node.json` at `0600` and never logs it. It is deliberately NOT an env var: a
 * credential in the environment on the box must ALSO be named in `CEZ_ENV_PASSTHROUGH`, and
 * forgetting that second step fails silently as "the agent cannot see it".
 */
export const clusterJoinResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      nodeId: clusterNodeIdSchema,
      hubNodeId: clusterNodeIdSchema,
      hubUrl: z.string().min(1).max(500),
      /** The per-node HMAC secret every subsequent frame is signed with. */
      secret: z.string().min(1).max(512),
      protocol: clusterProtocolSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: clusterJoinFailureReasonSchema,
      /** Detail for the operator. The REASON is what anything branches on; this is never parsed. */
      message: z.string().max(500).optional(),
    })
    .strict(),
]);
export type ClusterJoinResponse = z.infer<typeof clusterJoinResponseSchema>;

/** The hub's record of a minted code. **The raw code is never stored** — only its SHA-256 digest,
 *  `auth/org-claim-token.ts`'s existing contract, verbatim. */
export const storedClusterEnrollCodeSchema = z
  .object({
    codeId: z.string().min(1).max(64),
    codeHash: z.string().min(1).max(128),
    createdAt: z.string(),
    expiresAt: z.string(),
    nodeName: clusterNodeNameSchema.optional(),
    redeemedAt: z.string().optional(),
    redeemedByNodeId: clusterNodeIdSchema.optional(),
    revokedAt: z.string().optional(),
  })
  .passthrough();
export type StoredClusterEnrollCode = z.infer<typeof storedClusterEnrollCodeSchema>;

// ---- this node's own identity + credential (`~/.cezar/cluster/node.json`, 0600) ----------------

/**
 * On-disk, `.passthrough()`, every field defaulted: a corrupt file degrades to defaults with one
 * warning and never fails boot (AGENTS.md → zero config).
 *
 * `labels` is persisted **for display only** — it is re-DISCOVERED every boot, because a label that
 * survives the capability disappearing is a lie the scheduler will act on.
 */
export const storedClusterNodeIdentitySchema = z
  .object({
    nodeId: clusterNodeIdSchema,
    nodeName: clusterNodeNameSchema,
    createdAt: z.string(),
    role: clusterNodeRoleSchema,
    /** Spoke only. */
    hubUrl: z.string().max(500).optional(),
    /** Spoke only. `0600`, and deliberately not in the environment — see `clusterJoinResponse`. */
    secret: z.string().max(512).optional(),
    acceptsDispatch: z.boolean().default(false),
    labels: z.array(clusterNodeLabelSchema).max(64).default([]),
  })
  .passthrough();
export type StoredClusterNodeIdentity = z.infer<typeof storedClusterNodeIdentitySchema>;

/**
 * This node, as `GET /api/v1/cluster` serves it. **It has no `secret` field at all** — the omission
 * is the mechanism, not an oversight: there is no key for a handler that spreads the stored record
 * to leak a credential into, and `.strict()` makes the attempt fail rather than pass silently.
 */
export const clusterSelfSchema = z
  .object({
    nodeId: clusterNodeIdSchema,
    nodeName: clusterNodeNameSchema,
    role: clusterNodeRoleSchema,
    labels: z.array(clusterNodeLabelSchema).max(64),
    acceptsDispatch: z.boolean(),
    protocol: clusterProtocolSchema,
    version: z.string().max(64),
    /** Present on a spoke. The hub's URL is not a credential; the secret that reaches it is. */
    hubUrl: z.string().max(500).optional(),
    capacity: clusterCapacitySchema.optional(),
    corpus: clusterCorpusStatusSchema.optional(),
  })
  .strict();
export type ClusterSelf = z.infer<typeof clusterSelfSchema>;

// ---- link health, and the refusals that are values ----------------------------------------------

/**
 * Why the hub refused a link. Values, not prose, for the same reason the join reasons are:
 * `protocol-major` is an upgrade, `bad-signature` is a credential, `node-disabled` is a revoke,
 * and an operator who cannot tell them apart fixes the wrong one.
 *
 * **Adding a member is a compatibility event, and this is a `z.enum`** — a spoke running an older
 * build parses an unrecognized reason as an INVALID frame and drops it whole (`link-client.ts`'s
 * `parseDownlink`), so it sees a bare close with no stated cause: the exact silent failure D40
 * exists to remove, delivered by the mechanism meant to explain it. `handshake-timeout` was added
 * on 2026-08-23 after checking that no such spoke can exist — `@loki-labs/better-cezar` has never
 * been published (`npm view` → 404), `packages/contract` is private, and `CEZ_CLUSTER` is unset on
 * every box. **Re-check both before adding the next one**, and prefer teaching the spoke to parse
 * this leniently (a known-value union with an `unknown` fallback) over relying on that check
 * holding forever.
 */
export const clusterLinkRefuseReasonSchema = z.enum([
  'protocol-major',
  'unknown-node',
  'bad-signature',
  'stale-principal',
  'node-disabled',
  'frame-too-large',
  /** The socket upgraded and then said nothing this hub could use, past `HELLO_DEADLINE_MS`. D40a:
   *  the spoke's own `handshakeTimeout` bounds the HTTP 101 only, so an upgrade that SUCCEEDS on a
   *  link the hub never serves — a `hello` dropped as unparseable, leaving `helloReceived` false —
   *  wedges at `connecting` forever with ping/pong keeping the socket healthy. Only the hub knows
   *  whether a socket it accepted ever spoke, so only the hub can end it. */
  'handshake-timeout',
  'internal',
]);
export type ClusterLinkRefuseReason = z.infer<typeof clusterLinkRefuseReasonSchema>;

export const clusterLinkStateSchema = z.enum([
  'disabled',
  'connecting',
  'online',
  'offline',
  'refused',
]);
export type ClusterLinkState = z.infer<typeof clusterLinkStateSchema>;

export const clusterLinkHealthSchema = z
  .object({
    state: clusterLinkStateSchema,
    since: z.string().optional(),
    lastFrameAt: z.string().optional(),
    /**
     * D16: a watcher that stops firing is indistinguishable from a quiet system, and macOS
     * `fs.watch` is known to go quiet across sleep. So a low-frequency FULL reconcile runs
     * regardless of whether any op arrived, and its last-success time is the health signal — the
     * one number that separates "nothing changed" from "nothing is arriving".
     */
    lastReconcileAt: z.string().optional(),
    refusedReason: clusterLinkRefuseReasonSchema.optional(),
    /** Exponential backoff with FULL jitter (`sources/sync.ts`'s own shape). Rendered so an
     *  operator can see the link is waiting rather than dead. */
    retryAt: z.string().optional(),
  })
  .strict();
export type ClusterLinkHealth = z.infer<typeof clusterLinkHealthSchema>;

// ---- `GET /api/v1/cluster` -----------------------------------------------------------------------

/**
 * **There is no `enabled` field, and its absence is deliberate.** An earlier draft carried one, as
 * the payload of a 200 this route never sends: the family answers 409 while `CEZ_CLUSTER` is unset
 * (module header), so a body that reaches a reader can only ever say `enabled: true`. A field with
 * one possible value is dead weight that invites a consumer to write a branch that never runs.
 * `capabilities.cluster` is how a caller knows before asking; the 409 is how it finds out if it
 * asks anyway.
 */
export const clusterOverviewResponseSchema = z
  .object({
    /**
     * Absent only when clustering is ON but this node has no identity yet — a read-only home, or a
     * mint that failed. Degrade to a smaller working cockpit, never fail the boot (AGENTS.md → zero
     * config); inventing an identity to fill the shape would create a node that does not exist.
     * NOT the flag-off case: that one never reaches a handler.
     */
    self: clusterSelfSchema.optional(),
    nodes: z.array(clusterNodeSchema),
    pairings: z.array(clusterPairingSchema),
    proposals: z.array(clusterPairingProposalSchema),
    link: clusterLinkHealthSchema,
  })
  .strict();
export type ClusterOverviewResponse = z.infer<typeof clusterOverviewResponseSchema>;

export const clusterNodeIdParamSchema = z.object({ nodeId: clusterNodeIdSchema }).strict();
export type ClusterNodeIdParam = z.infer<typeof clusterNodeIdParamSchema>;

export const clusterNodePatchSchema = z
  .object({
    /** D11: the hub records it, and the SPOKE re-enforces it — a node refuses work it has not
     *  opted into regardless of what the hub sends, the same "verify at the boundary that actually
     *  enforces it" posture as `supervisor/forwarded-principal.ts`. */
    acceptsDispatch: z.boolean().optional(),
    nodeName: clusterNodeNameSchema.optional(),
  })
  .strict();
export type ClusterNodePatch = z.infer<typeof clusterNodePatchSchema>;

export const clusterNodeRevokeResponseSchema = z.object({ revoked: z.boolean() }).strict();
export type ClusterNodeRevokeResponse = z.infer<typeof clusterNodeRevokeResponseSchema>;

export const clusterPairingsResponseSchema = z
  .object({
    proposals: z.array(clusterPairingProposalSchema),
    pairings: z.array(clusterPairingSchema),
  })
  .strict();
export type ClusterPairingsResponse = z.infer<typeof clusterPairingsResponseSchema>;

export const clusterProjectKeyParamSchema = z
  .object({ projectKey: clusterProjectKeySchema })
  .strict();
export type ClusterProjectKeyParam = z.infer<typeof clusterProjectKeyParamSchema>;

export const clusterPairingActionSchema = z
  .object({
    action: z.enum(['confirm', 'unpair']),
    /** Which node's local project this confirmation is about. A pairing is confirmed per node,
     *  because that is the grant being made: this repo, on that machine. */
    nodeId: clusterNodeIdSchema,
    projectId: z.string().min(1).max(200),
  })
  .strict();
export type ClusterPairingAction = z.infer<typeof clusterPairingActionSchema>;

// ---- the corpus routes (D8a) ---------------------------------------------------------------------

export const clusterCorpusDocSchema = z
  .object({
    /** Corpus-relative, always — `knowledge/foo.md`, never an absolute path on the hub. */
    path: z.string().min(1).max(500),
    hash: z.string().min(1).max(128),
    size: z.number().int().nonnegative(),
    mtime: z.string(),
  })
  .strict();
export type ClusterCorpusDoc = z.infer<typeof clusterCorpusDocSchema>;

/** Scoped to the ASKING node's mirror set: a node that does not mirror `reports/` is not told what
 *  is in it. */
export const clusterCorpusManifestResponseSchema = z
  .object({
    corpusVersion: z.string().min(1).max(120),
    scope: z.array(clusterCorpusScopeSchema).max(32),
    docs: z.array(clusterCorpusDocSchema),
    /** Explicit tombstones. **Never absence-diffing**: a document missing from one delta is not
     *  evidence of deletion — the bug a hand-rolled rsync-shaped mirror ships. */
    tombstones: z.array(z.object({ path: z.string().max(500), at: z.string() }).strict()),
    /** Resumable sweeps: false means this manifest is a page, not the whole corpus, and `truncated`
     *  is distinguished from failed so a spoke that was asleep resumes rather than refetching. */
    complete: z.boolean(),
  })
  .strict();
export type ClusterCorpusManifestResponse = z.infer<typeof clusterCorpusManifestResponseSchema>;

/**
 * `GET /api/v1/cluster/corpus/*path` — one document body, addressed by its corpus-relative path.
 *
 * **The one param in this family that is NOT middleware, and it is a constraint rather than a
 * preference.** Binding a wildcard needs a NAMED param — `/cluster/corpus/:path{.+}` — and
 * `bc-route-inventory.test.ts` brace-expands every backticked path in `BACKWARD_COMPATIBILITY.md`
 * §2, so its `expandBraces` turns `{.+}` into `.+`: the doc entry normalizes to
 * `…/corpus/:p.+` while the registered route normalizes to `…/corpus/:p{.+}`, and the inventory
 * gate fails. Measured by package 1.0 on 2026-08-23, which correctly declined to edit
 * `expandBraces` — relaxing an assertion to make a suite pass is how a gate stops being one.
 *
 * So the route stays `/cluster/corpus/*` and this schema is parsed **at the top of the handler**,
 * against `c.req.param('*')`. Two obligations for whoever fills that handler (package 3b.2), and
 * the second is not optional because the first passed:
 *
 *  1. parse with this schema — the bound is not applied by anything else;
 *  2. **scope-check the result.** A wildcard segment is the one param a caller composes freely, so
 *     "it parsed" is never "it is in scope". `reports/` is off by default because it is 196 files
 *     carrying phone numbers and chat ids, and a path that merely validates can still name them.
 */
export const clusterCorpusPathParamSchema = z
  .object({ path: z.string().min(1).max(500) })
  .strict();
export type ClusterCorpusPathParam = z.infer<typeof clusterCorpusPathParamSchema>;

/**
 * `POST /api/v1/cluster/corpus/submit` — **the only write direction the corpus has** (D8, D8a).
 * `--add-dir` grants an agent write access to the mirror path directly, so `readOnly: true` on the
 * root is not sufficient on a spoke: the sweep quarantines a diverged file rather than overwriting
 * it, and this route is the correct path that is easier than the wrong one. A rule that only
 * forbids, without offering the affordance it replaces, gets routed around.
 */
export const clusterCorpusSubmitRequestSchema = z
  .object({
    path: z.string().min(1).max(500),
    body: z.string().max(1_000_000),
    /** The version the submitter last saw, so the hub can refuse a blind overwrite. */
    baseVersion: z.string().max(120).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
export type ClusterCorpusSubmitRequest = z.infer<typeof clusterCorpusSubmitRequestSchema>;

export const clusterCorpusSubmitResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), path: z.string(), corpusVersion: z.string() }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(['out-of-scope', 'stale-base', 'read-only-path', 'too-large']),
      message: z.string().max(500).optional(),
    })
    .strict(),
]);
export type ClusterCorpusSubmitResponse = z.infer<typeof clusterCorpusSubmitResponseSchema>;

// ---- todos snapshot, backup, append (D21) ---------------------------------------------------------

/**
 * D21: the ONE new HTTP read `cluster/reconcile.ts#RemoteReconcileTransport` needed —
 * `GET /api/v1/cluster/todos/:projectKey` returns a snapshot of the HUB's own `todos.json` for that
 * project, node-authenticated (D20) and scoped to a CONFIRMED pairing with the caller
 * (`server/cluster-routes.ts`). `POST …/backup` and `POST …/append` are reconcile's write half —
 * `backup()`/`apply()` on the same transport interface, run FROM the spoke AGAINST the hub (a spoke
 * has no inbound address — D21, Problem §7).
 *
 * **Every field here mirrors the ON-DISK shape, not the cockpit-facing `todoItemSchema`**
 * (`./skills.ts`). `cluster/reconcile.ts#classify` needs `hubSeq` to tell "never seen the hub" from
 * "already ordered" apart, and `apply` must copy a record across without dropping the fields that
 * make it idempotent and resumable on the receiving side (`pendingSince`/`pendingFields`/`hubSeq`/
 * `tombstone`/`placement`/`startedOn`) — reconcile never rewrites a field, so the wire shape has to
 * carry every one of them, not the two `todoItemSchema` renders. `skills.ts` cannot be imported
 * here either way: it already imports FROM this file, and the reverse would be a cycle — so the
 * base fields are declared again rather than shared, the same duplication `todoKnowledgeRefSchema`
 * would otherwise force onto this file too.
 *
 * **CORRECTED 2026-08-23 (code review, before this package's first commit) — `.strict()` alone,
 * with no D13 tolerance at all, was the wrong trade.** This docblock used to end this paragraph at
 * "no `.passthrough()` anywhere in this schema … and no D13 `unknown`-bag catch-all field either",
 * accepting that a field this schema does not name is DROPPED by `.strict()` parsing. Measured
 * cost, not a theoretical one: `.strict()` does not strip an unknown key, it REJECTS the whole
 * payload — one row in a snapshot carrying one field this build has never heard of 400s the entire
 * `/append` request and fails the entire `GET` snapshot, not just that row. Read against
 * `todos.ts#storedTodoSchema`'s own docblock, that is exactly the scenario D13 exists to survive:
 * *"wrong the moment a newer node in the cluster writes a field this build has never heard of …
 * the older node would drop it on the next rewrite and silently truncate everyone's history."*
 * Reconcile IS that cross-node backfill, and a hub/spoke pair upgrading at different times is this
 * system's normal state, not an edge case — the failure read as corrupt data instead of version
 * skew, which sends whoever hits it in exactly the wrong direction.
 *
 * The fix is the split this codebase already uses twice for this identical reason —
 * `todos.ts#todoSchema`/`storedTodoSchema`, and this file's own `clusterOpSchema`/
 * `storedClusterOpSchema` two sections up. `clusterTodoRecordSchema` below stays exactly as the
 * bisection measured it: `.strict()`, used for the exported `ClusterTodoRecord` TYPE and by
 * `contract-parity.cluster.test.ts`'s route-vs-schema check. `storedClusterTodoRecordSchema`,
 * defined right after it, is its `.passthrough()` twin.
 *
 * **AMENDED 2026-08-23, same day — putting the stored twin directly into the three response/
 * request schemas, as this paragraph originally said, does not work: it reproduces the identical
 * `'schema-is-wider'` failure one level up.** Measured: wiring `storedClusterTodoRecordSchema`
 * into `clusterTodosSnapshotResponseSchema.todos` and `clusterTodosAppendResponseSchema.appended`
 * makes THOSE schemas' own `z.infer<>` carry the index signature, and
 * `contract-parity.cluster.test.ts`'s `Assert<Exact<z.infer<typeof clusterTodosSnapshotResponseSchema>,
 * TodosSnapshot200>>` (and the append equivalent) fail exactly the same way `clusterTodoRecordSchema`
 * itself did before this correction — the bug fires on ANY schema whose inferred type embeds an
 * index signature and is compared through this deferred-generic `Exact<>`, not only on
 * `clusterTodoRecordSchema` specifically. The REQUEST side is the one exception: wiring the stored
 * twin into `clusterTodosAppendRequestSchema.todos` measurably does NOT break its parity assertion
 * (`Assert<Exact<z.input<typeof clusterTodosAppendRequestSchema>, TodosAppendBody>>` stayed green) —
 * apparently `InferRequestType` doesn't route through whatever normalization step trips
 * `InferResponseType` up, though this codebase has not chased down why.
 *
 * The actual placement of the passthrough boundary follows from where each schema is really
 * `.parse()`'d, not from where its TYPE is used: **`clusterTodosAppendRequestSchema` is a real
 * runtime gate** — `jsonZodValidator` calls it on every incoming `/append` body — so it keeps the
 * stored twin directly, and that is the one schema level where a `.strict()` mistake would have
 * actually 400'd a whole request. `clusterTodosSnapshotResponseSchema` and
 * `clusterTodosAppendResponseSchema`, by contrast, are **never parsed server-side at all** —
 * `c.json(body)` just types `body` with them and calls `JSON.stringify`, which serializes whatever
 * fields the real on-disk record actually has regardless of the stated TS type, so leaving THEM
 * plain costs nothing on the wire. The one place a response really is `.parse()`'d is client-side,
 * in `cluster/reconcile-transport.ts`, so that is where the tolerance has to live: two more schemas
 * declared right after their plain counterparts below, `storedClusterTodosSnapshotResponseSchema`
 * and `storedClusterTodosAppendResponseSchema`, both built on `storedClusterTodoRecordSchema`, and
 * it is those two the transport parses with. `clusterTodosBackupResponseSchema` needs no such twin —
 * it carries no todo-record array. The parity check only ever compares the PLAIN response/request
 * schemas, so it never sees an index signature; the runtime keeps D13's tolerance at both real
 * enforcement points (the `/append` request validator and the transport's response parsing) without
 * the type-level schemas the parity check touches ever going passthrough.
 *
 * **The bisection below is kept, unchanged, because it is still exactly why `tombstone` and
 * `placement` are spelled out as their OWN `.strict()` shapes on the PLAIN schema, rather than
 * reused from their already-`.passthrough()` stored siblings** (`storedClusterTombstoneSchema` /
 * `storedClusterTodoPlacementSchema`): doing that on `clusterTodoRecordSchema` itself would
 * reproduce precisely the measured bug below, even with the wire twin now sitting alongside it —
 * the plain schema has to stay genuinely index-signature-free everywhere, not just at its own top
 * level, or the parity check breaks again for the same reason.
 *
 * Both were tried first and both are the module header's usual discipline ("wire is `.strict()`,
 * on-disk is `.passthrough()`" — `tombstone`/`placement` would otherwise reuse the already-existing
 * `storedClusterTombstoneSchema`/`storedClusterTodoPlacementSchema`, and `ClusterOp.unknown`'s own
 * `z.record(z.string(), z.unknown())` idiom looked like the obvious D13 hatch). **Both are
 * measurably rejected** as a way to make `clusterTodoRecordSchema` ITSELF tolerant: any field whose
 * TS type carries an index signature into `unknown` — a `.passthrough()`'d nested object, or a bare
 * `z.record(_, z.unknown())` — makes Hono's `InferResponseType` and this schema's own `z.infer`
 * disagree in a way `contract-parity.cluster.test.ts`'s generic `Mutual` check catches as
 * `'schema-is-wider'`, even though a DIRECT (non-generic) structural comparison of the two types
 * looks identical. Bisected field-by-field against the real route on 2026-08-23: `tombstone`,
 * `placement` and a trial `unknown` field each independently reproduced it; every other field
 * (including three enums, two nested arrays, and an imported `taskAuthorSchema`) did not.
 */
export const clusterTodoRecordSchema = z
  .object({
    id: z.string().min(1),
    ts: z.string().optional(),
    taskId: z.string().optional(),
    summary: z.string().min(1),
    action: z.string().optional(),
    prUrl: z.string().optional(),
    suggestedSkill: z.string().optional(),
    suggestedArgs: z.string().optional(),
    suggestedPrompt: z.string().optional(),
    runnable: z.boolean().optional(),
    startedTaskId: z.string().optional(),
    status: z.enum(['todo', 'in-progress', 'blocked', 'done']).optional(),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    archivedAt: z.string().optional(),
    context: z.string().max(20_000).optional(),
    whatToDo: z.string().max(100_000).optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(500)).max(20).optional(),
    knowledgeRefs: z
      .array(z.object({ project: z.string().min(1).max(64), slug: z.string().min(1).max(500), title: z.string().min(1).max(300) }).strict())
      .max(20)
      .optional(),
    origin: z.enum(['agent', 'composer']).optional(),
    autostart: z.boolean().optional(),
    author: taskAuthorSchema.optional(),
    // ---- the six additive cluster fields (`clusterTodoFieldsSchema`'s own shape, strict-ified) --
    pendingSince: z.string().optional(),
    pendingFields: z.array(z.string().min(1).max(120)).max(32).optional(),
    hubSeq: clusterHubSeqSchema.optional(),
    tombstone: z.object({ at: z.string() }).strict().optional(),
    placement: clusterTodoPlacementSchema.optional(),
    startedOn: clusterNodeIdSchema.optional(),
  })
  .strict();
export type ClusterTodoRecord = z.infer<typeof clusterTodoRecordSchema>;

/** The wire twin — see `clusterTodoRecordSchema`'s own docblock above (in particular the
 *  "AMENDED 2026-08-23, same day" paragraph) for exactly which schemas use this and which stay
 *  plain, and why: `clusterTodosAppendRequestSchema` below uses it directly (the real incoming
 *  validator), and `storedClusterTodosSnapshotResponseSchema` / `storedClusterTodosAppendResponseSchema`
 *  (declared beside their plain counterparts) use it for the transport's client-side response
 *  parsing. `clusterTodoRecordSchema` itself stays the `ClusterTodoRecord` TYPE and the
 *  contract-parity check's schema. */
export const storedClusterTodoRecordSchema = clusterTodoRecordSchema.passthrough();
export type StoredClusterTodoRecord = z.infer<typeof storedClusterTodoRecordSchema>;

export const clusterTodosSnapshotResponseSchema = z
  .object({
    projectKey: clusterProjectKeySchema,
    todos: z.array(clusterTodoRecordSchema),
  })
  .strict();
export type ClusterTodosSnapshotResponse = z.infer<typeof clusterTodosSnapshotResponseSchema>;

/** The wire twin of the response above — see `clusterTodoRecordSchema`'s docblock ("CORRECTED
 *  2026-08-23, amended same day") for why a response schema needs a SEPARATE stored variant rather
 *  than using the stored record type directly: `c.json()` never actually parses this schema
 *  server-side (it only types the handler's return value, and `JSON.stringify` serializes whatever
 *  is really on disk regardless of that type), so the plain schema above is what the parity check
 *  compares and it stays index-signature-free. The one real `.parse()` of a snapshot response is
 *  client-side, in `cluster/reconcile-transport.ts`, which uses THIS schema instead so a row
 *  carrying a field this build has never heard of survives the round trip rather than throwing. */
export const storedClusterTodosSnapshotResponseSchema = z
  .object({
    projectKey: clusterProjectKeySchema,
    todos: z.array(storedClusterTodoRecordSchema),
  })
  .strict();
export type StoredClusterTodosSnapshotResponse = z.infer<typeof storedClusterTodosSnapshotResponseSchema>;

/** `POST /api/v1/cluster/todos/:projectKey/backup` — writes `todos.json.bak` on the hub from
 *  whatever the hub currently holds. The transport's own contract calls this before the FIRST
 *  mutation of a reconcile pass, whether or not this peer ends up receiving any adds — the
 *  zero-adds case has no append to ride along with, so this stays its own route rather than folding
 *  into `/append` (D21's amendment). Idempotent: overwriting `todos.json.bak` with a fresher
 *  snapshot is the whole of what "does not conflict with a preceding call" means here. */
export const clusterTodosBackupResponseSchema = z.object({ path: z.string().min(1).max(1000) }).strict();
export type ClusterTodosBackupResponse = z.infer<typeof clusterTodosBackupResponseSchema>;

/** `POST /api/v1/cluster/todos/:projectKey/append`'s body — bounded like a link frame's own op
 *  batch (`CLUSTER_OPS_PER_FRAME_MAX`), for the same reason: an unbounded array is an unbounded
 *  server-side merge. */
export const clusterTodosAppendRequestSchema = z
  .object({ todos: z.array(storedClusterTodoRecordSchema).max(CLUSTER_OPS_PER_FRAME_MAX) })
  .strict();
export type ClusterTodosAppendRequest = z.infer<typeof clusterTodosAppendRequestSchema>;

/**
 * `POST /api/v1/cluster/todos/:projectKey/append`'s response. **AMENDED 2026-08-23 — this route
 * takes its OWN backup, inside its OWN lease, rather than trusting a `/backup` call that may have
 * landed a round trip ago** (D21's amendment): composing `/backup` then `/append` as two separate
 * HTTP calls — two separate lease acquisitions on the hub — leaves a window where a concurrent
 * local write on the hub lands in between, and is silently absent from the `/backup` snapshot even
 * though the LIVE file (correctly) picked it up. `backupPath` here is always THIS append's own
 * fresh snapshot, taken under the same lease as the write that follows it, never the path an
 * earlier `/backup` call wrote.
 */
export const clusterTodosAppendResponseSchema = z
  .object({
    /** Rows actually written — an id already present on the hub is skipped and never listed here
     *  (idempotent by id). A retried append is therefore safe to re-send verbatim. */
    appended: z.array(clusterTodoRecordSchema),
    backupPath: z.string().min(1).max(1000),
  })
  .strict();
export type ClusterTodosAppendResponse = z.infer<typeof clusterTodosAppendResponseSchema>;

/** The wire twin — same reasoning as `storedClusterTodosSnapshotResponseSchema` above: the hub
 *  never actually parses this schema on the way out, only types the handler's return value with
 *  it, so it stays plain for the parity check. `cluster/reconcile-transport.ts` parses an
 *  `/append` response with THIS schema instead, so a `appended[]` row carrying a field this build
 *  has never heard of — e.g. echoed back from a hub newer than this spoke — survives rather than
 *  throwing client-side. */
export const storedClusterTodosAppendResponseSchema = z
  .object({
    appended: z.array(storedClusterTodoRecordSchema),
    backupPath: z.string().min(1).max(1000),
  })
  .strict();
export type StoredClusterTodosAppendResponse = z.infer<typeof storedClusterTodosAppendResponseSchema>;

// ---- leases (D15b) and the allocator (D19 rung 2) ------------------------------------------------

/**
 * What is still a lease after D4/D9a, and what is not. **A claim is no longer here**: the hub
 * linearizes, so its acknowledgement IS the stamp — there is no second holder to race and no window
 * between acquiring and stamping. What remains guards a RESOURCE rather than a record.
 *
 * (The spec's API-contracts line still writes `claim | account | scheduler`; D4/D9a supersede it in
 * the same document, and PLAN 3.1 says so outright — "claims are explicitly not here any more".)
 */
export const clusterLeaseKindSchema = z.enum([
  'account',
  'usage-aggregation',
  'limit-hold',
  'scheduler',
]);
export type ClusterLeaseKind = z.infer<typeof clusterLeaseKindSchema>;

const clusterLeaseShape = {
  kind: clusterLeaseKindSchema,
  /** What is being held: an account key, a scheduler name, a limit id. */
  id: z.string().min(1).max(200),
  holderNodeId: clusterNodeIdSchema,
  acquiredAt: z.string(),
  expiresAt: z.string(),
  /** Monotonic per (kind, id). A reconnecting spoke RE-ASSERTS the leases it still holds and the
   *  hub honours a re-assertion from the node already recorded as holder — the blue-green hub
   *  restarts ~10×/day, and an in-memory table would be wiped every time (D15b). */
  fencingToken: z.number().int().nonnegative(),
} as const;

export const clusterLeaseSchema = z.object(clusterLeaseShape).strict();
export type ClusterLease = z.infer<typeof clusterLeaseSchema>;

export const storedClusterLeaseSchema = z.object(clusterLeaseShape).passthrough();
export type StoredClusterLease = z.infer<typeof storedClusterLeaseSchema>;

export const clusterLeaseKindParamSchema = z.object({ kind: clusterLeaseKindSchema }).strict();
export type ClusterLeaseKindParam = z.infer<typeof clusterLeaseKindParamSchema>;

export const clusterLeaseIdParamSchema = z
  .object({ kind: clusterLeaseKindSchema, id: z.string().min(1).max(200) })
  .strict();
export type ClusterLeaseIdParam = z.infer<typeof clusterLeaseIdParamSchema>;

export const clusterLeaseRequestSchema = z
  .object({
    id: z.string().min(1).max(200),
    ttlMs: z.number().int().min(1_000).max(3_600_000),
    /** Present on a renew or a post-reconnect re-assertion; absent on a fresh acquire. */
    fencingToken: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ClusterLeaseRequest = z.infer<typeof clusterLeaseRequestSchema>;

export const clusterLeaseResponseSchema = z.discriminatedUnion('acquired', [
  z.object({ acquired: z.literal(true), lease: clusterLeaseSchema }).strict(),
  z
    .object({
      acquired: z.literal(false),
      /** Who holds it, so a refusal is actionable rather than a dead end. */
      heldBy: clusterNodeIdSchema,
      expiresAt: z.string(),
    })
    .strict(),
]);
export type ClusterLeaseResponse = z.infer<typeof clusterLeaseResponseSchema>;

export const clusterLeaseReleaseResponseSchema = z.object({ released: z.boolean() }).strict();
export type ClusterLeaseReleaseResponse = z.infer<typeof clusterLeaseReleaseResponseSchema>;

/**
 * The kind of scarce shared identity being handed out. A bounded string, not a union — `sources.ts`
 * makes the argument: a literal union is the `ForgeKind` mistake, and this one is published in
 * `@loki-labs/better-cezar-contract`, where widening an enum is exactly what PLAN P8 forbids.
 *
 * `spec-number` is the first, and it is the one that matters: `next-spec` reads one disk and
 * reserves NOTHING, so two spokes collide more readily than two local sessions do. **Skipping this
 * makes multi-node worse than one machine** — the single place in this design where the cluster
 * regresses something rather than just not improving it.
 */
export const clusterAllocateKindSchema = z.string().min(1).max(32);
export const CLUSTER_ALLOCATE_KIND_SPEC_NUMBER = 'spec-number';

export const clusterAllocateKindParamSchema = z
  .object({ kind: clusterAllocateKindSchema })
  .strict();
export type ClusterAllocateKindParam = z.infer<typeof clusterAllocateKindParamSchema>;

export const clusterAllocateRequestSchema = z
  .object({
    count: z.number().int().min(1).max(50).optional(),
    projectKey: clusterProjectKeySchema.optional(),
    /** Recorded with the allocation, so a number handed out and never used is explicable later. */
    reason: z.string().max(200).optional(),
  })
  .strict();
export type ClusterAllocateRequest = z.infer<typeof clusterAllocateRequestSchema>;

const clusterAllocationShape = {
  kind: clusterAllocateKindSchema,
  /** Strings, because a spec number is rendered `SPEC-417` and the next scarce identity may not be
   *  numeric at all. */
  values: z.array(z.string().min(1).max(120)),
  allocatedAt: z.string(),
  byNodeId: clusterNodeIdSchema,
  projectKey: clusterProjectKeySchema.optional(),
  reason: z.string().max(200).optional(),
} as const;

export const clusterAllocateResponseSchema = z.object(clusterAllocationShape).strict();
export type ClusterAllocateResponse = z.infer<typeof clusterAllocateResponseSchema>;

export const storedClusterAllocationSchema = z.object(clusterAllocationShape).passthrough();
export type StoredClusterAllocation = z.infer<typeof storedClusterAllocationSchema>;

// ---- account grants (D14, tier 2) ------------------------------------------------------------------

/**
 * The account grant is a bound on SUBSCRIPTION SPEND; `ClusterCapacity` is a bound on HOST
 * CAPACITY. The two must not be conflated — a node can have capacity and no grant, or a grant and
 * no capacity — so **each refusal names which**, and neither reason is ever rendered as the other.
 */
export const clusterAccountGrantRefusalSchema = z.enum([
  'account-at-limit',
  'limit-hold',
  'no-lease',
  'unknown-account',
]);
export type ClusterAccountGrantRefusal = z.infer<typeof clusterAccountGrantRefusalSchema>;

export const clusterAccountGrantSchema = z
  .object({
    accountKey: z.string().min(1).max(200),
    nodeId: clusterNodeIdSchema,
    runId: z.string().min(1).max(120),
    grantedAt: z.string(),
    expiresAt: z.string(),
  })
  .strict();
export type ClusterAccountGrant = z.infer<typeof clusterAccountGrantSchema>;

export const clusterAccountGrantDecisionSchema = z.discriminatedUnion('granted', [
  z.object({ granted: z.literal(true), grant: clusterAccountGrantSchema }).strict(),
  z
    .object({
      granted: z.literal(false),
      reason: clusterAccountGrantRefusalSchema,
      /** When the hold is expected to lift, when that is known. A parked node should wait, not poll
       *  blindly. */
      retryAt: z.string().optional(),
    })
    .strict(),
]);
export type ClusterAccountGrantDecision = z.infer<typeof clusterAccountGrantDecisionSchema>;

// ---- dispatch (D12a, D11, D15a) ---------------------------------------------------------------------

/**
 * Why a target refused work it was offered. Values, not prose — "it ran, on the wrong commit, on a
 * machine you weren't looking at" is the expensive outcome, and an operator has to be able to tell
 * *behind* from *mid-conflict* from *this node was never opted in*.
 *
 * `corpus-stale` is D8a's: a knowledge read has no natural error, so a mirror behind its bound
 * refuses with the corpus NAMED rather than running against a five-day-old record and reporting
 * success.
 *
 * **`start-failed` (D48) is the one member that is not a pre-start condition.** Every other value
 * is decided BEFORE any side effect — `dispatch.ts#dispatchRefusalReason`'s own docblock is
 * explicit that it "is checked before anything below has any side effect". `start-failed` is what
 * the target sends when every one of those eight checks passed and it attempted the run anyway,
 * and `RunManager.startRun` (or whatever underneath it) threw. There is no pre-start reason to
 * name in that case — the checks were honest — so this exists rather than forcing a lie onto one
 * of the other eight (`at-capacity` in particular would misreport WHY nothing started).
 */
export const clusterDispatchRefusalReasonSchema = z.enum([
  'dispatch-not-accepted',
  'behind',
  'dirty',
  'merging',
  'corpus-stale',
  'unpaired-project',
  'at-capacity',
  'unknown-workflow',
  'start-failed',
]);
export type ClusterDispatchRefusalReason = z.infer<typeof clusterDispatchRefusalReasonSchema>;

/**
 * The workflow a dispatch carries — **by value, never by name** (D12a). `WORKFLOWS_DIR` is
 * `.ai/cezar/workflows`, inside the gitignored `.ai/cezar/`, so a repo-local workflow never travels
 * by git and the target may simply not have the one the dispatcher named. Sending a name and hoping
 * is how a run silently executes a different chain from the one that was asked for; adding a fifth
 * replicated store to fix that would be worse than sending 2 KB of YAML.
 *
 * `def` is re-validated against `workflowDefSchema` ON ARRIVAL, by the node that will run it.
 */
export const clusterDispatchWorkflowSchema = z.union([
  z.object({ builtinId: z.string().min(1).max(120) }).strict(),
  z.object({ def: workflowDefSchema }).strict(),
]);
export type ClusterDispatchWorkflow = z.infer<typeof clusterDispatchWorkflowSchema>;

// ---- link frames -------------------------------------------------------------------------------------

/**
 * Every frame carries `protocol`, not just the handshake. The hub blue-green deploys ~10×/day, so a
 * link resumes far more often than it is established, and a frame that cannot be read without
 * knowing its version has to say which version it is.
 */

/** → spoke to hub. `watermarks` is what makes a resume a resume: the hub replies with `resumeFrom`
 *  rather than replaying from zero. `projects` carries ONLY what this node has paired. */
export const clusterHelloFrameSchema = z
  .object({
    type: z.literal('hello'),
    protocol: clusterProtocolSchema,
    nodeId: clusterNodeIdSchema,
    nodeName: clusterNodeNameSchema,
    version: z.string().max(64),
    labels: z.array(clusterNodeLabelSchema).max(64),
    watermarks: z.array(clusterWatermarkSchema).max(500),
    projects: z.array(clusterProjectAdvertSchema).max(200),
    /** Leases this node still believes it holds, re-asserted after a hub restart (D15b). */
    heldLeases: z.array(clusterLeaseSchema).max(100).optional(),
  })
  .strict();
export type ClusterHelloFrame = z.infer<typeof clusterHelloFrameSchema>;

/** ← hub to spoke. */
export const clusterWelcomeFrameSchema = z
  .object({
    type: z.literal('welcome'),
    protocol: clusterProtocolSchema,
    hubNodeId: clusterNodeIdSchema,
    roster: z.array(clusterNodeSchema),
    pairings: z.array(clusterPairingSchema),
    proposals: z.array(clusterPairingProposalSchema).optional(),
    resumeFrom: z.array(clusterWatermarkSchema).max(500),
  })
  .strict();
export type ClusterWelcomeFrame = z.infer<typeof clusterWelcomeFrameSchema>;

/** ← hub to spoke. The link is refused as a whole; a partial apply that looks complete is worse. */
export const clusterRefuseFrameSchema = z
  .object({
    type: z.literal('refuse'),
    protocol: clusterProtocolSchema,
    reason: clusterLinkRefuseReasonSchema,
    message: z.string().max(500).optional(),
  })
  .strict();
export type ClusterRefuseFrame = z.infer<typeof clusterRefuseFrameSchema>;

/** → spoke to hub: the outbox flush, capped at `CLUSTER_OPS_PER_FRAME_MAX`. */
export const clusterOpsFrameSchema = z
  .object({
    type: z.literal('ops'),
    protocol: clusterProtocolSchema,
    scope: clusterOpScopeSchema,
    projectKey: clusterProjectKeySchema.optional(),
    ops: z.array(clusterOpSchema).max(CLUSTER_OPS_PER_FRAME_MAX),
  })
  .strict();
export type ClusterOpsFrame = z.infer<typeof clusterOpsFrameSchema>;

/**
 * ← hub to spoke: the hub's assigned order, echoed back.
 *
 * `results` is what makes D9a's **confirm before start** implementable: "send the claim op → wait
 * for the hub's acknowledgement, WHICH CARRIES the applied `startedTaskId`/`startedOn` → then
 * start." A cross-node duplicate is two agents in two worktrees on two machines, neither able to
 * see the other, spending one subscription twice — so the claim is the one write that never applies
 * optimistically, and the ack is where its verdict arrives.
 */
export const clusterAckResultSchema = z
  .object({
    opId: z.string().min(1).max(64),
    hubSeq: clusterHubSeqSchema,
    accepted: z.boolean(),
    /** The APPLIED field values, when the hub's result differs from what was proposed — a claim
     *  another node already won comes back `accepted: false` with the winner's `startedOn`. */
    fields: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().max(200).optional(),
  })
  .strict();
export type ClusterAckResult = z.infer<typeof clusterAckResultSchema>;

export const clusterAckFrameSchema = z
  .object({
    type: z.literal('ack'),
    protocol: clusterProtocolSchema,
    scope: clusterOpScopeSchema,
    projectKey: clusterProjectKeySchema.optional(),
    /** Everything at or below this is durably applied at the hub and may be dropped from the
     *  outbox. */
    throughHubSeq: clusterHubSeqSchema,
    results: z.array(clusterAckResultSchema).max(CLUSTER_OPS_PER_FRAME_MAX).optional(),
  })
  .strict();
export type ClusterAckFrame = z.infer<typeof clusterAckFrameSchema>;

/** ← hub to spoke: **the only write-down path there is.** Foreign ops are applied THROUGH the store
 *  API under the existing lease, never by writing the file (D7) — so the existing `fs.watch` fires,
 *  the Tasks board and the WS topics update with no new read path anywhere, and a replicated write
 *  can never interleave with a local one. */
export const clusterReplicaFrameSchema = z
  .object({
    type: z.literal('replica'),
    protocol: clusterProtocolSchema,
    scope: clusterOpScopeSchema,
    projectKey: clusterProjectKeySchema.optional(),
    changes: z.array(clusterOpSchema).max(CLUSTER_OPS_PER_FRAME_MAX),
    /** The highest order in `changes`. Applying is idempotent: anything at or below the receiver's
     *  own watermark is dropped. */
    hubSeq: clusterHubSeqSchema,
  })
  .strict();
export type ClusterReplicaFrame = z.infer<typeof clusterReplicaFrameSchema>;

/**
 * ← hub to spoke.
 *
 * **Nothing here may become a local-machine affordance.** There is no path, no worktree, no session
 * and no handoff target in this frame, and none may be added: a foreign run must never be able to
 * request "open in terminal" on somebody else's host.
 */
export const clusterDispatchFrameSchema = z
  .object({
    type: z.literal('dispatch'),
    protocol: clusterProtocolSchema,
    /** Correlates the offer with its acceptance or refusal, and with an `unattributed` run the hub
     *  later reconciles (D15). */
    dispatchId: z.string().min(1).max(64),
    todoId: z.string().min(1).max(200),
    projectKey: clusterProjectKeySchema,
    placement: clusterTodoPlacementSchema,
    workflow: clusterDispatchWorkflowSchema,
    /** D12a: the commit the hub believes the target is on. The target re-checks and REFUSES if it
     *  is behind or mid-conflict, naming which. An explicit override exists; the default is
     *  refusal. */
    expect: z.object({ headSha: z.string().min(1).max(64) }).strict().optional(),
    /** Set only by a human overriding a freshness refusal, never by the scheduler. */
    override: z.boolean().optional(),
  })
  .strict();
export type ClusterDispatchFrame = z.infer<typeof clusterDispatchFrameSchema>;

/**
 * → spoke to hub: the freshness report D12a requires before every dispatch, sent on change and
 * whenever an offer is answered.
 *
 * `refused` rides here rather than on a frame of its own, deliberately: this frame already exists to
 * answer "can this target take work", so a refusal is the same answer with its reason attached, and
 * the protocol keeps exactly the ten frames the spec fixes. Without it the hub can render only
 * "nothing happened", which is the failure the four named reasons exist to prevent.
 *
 * **`accepted` (D48) is that same argument applied to the other verdict, and it is load-bearing
 * beyond correlation.** The hub's dispatch correlation store (`cluster/hub-dispatch.ts`) can match
 * WHICH pending dispatch a bare accept reply belongs to by `(nodeId, projectKey)` alone — but only
 * when exactly one is in flight to that node for that project. Two non-overlapping dispatches to
 * one node's one project can be in flight at once (D19 rung 3's overlap check keys on touched
 * paths, not on project identity), so an accepted reply had to carry its own `dispatchId` for the
 * ambiguous case to be resolvable at all, the same way `refused` already does.
 *
 * **`runId` is not a correlation nicety — it is how the hub learns which run its dispatch produced,
 * without polling `GET /cluster/active` and guessing by `todoId` (C-a2, corrected by C-a3).** An
 * earlier version of this docblock said the hub stamps the dispatched todo once its correlation
 * store resolves this block — that is not implementable: a claim IS `startedTaskId`
 * (`hub-apply.ts#claimFields`), and the run id does not exist until the spoke's `startRun` mints
 * it, so the hub has nothing to claim with at dispatch time. What actually stamps the todo: the
 * spoke itself, optimistically and with `humanIntent: true` (the confirmed start of a run it just
 * caused, not the scheduler-denied escape hatch `todos.ts:840` guards against), the moment
 * `startRun` returns — the ordinary outbox flush carries that claim op to the hub, where
 * `applyOpAtHub` serializes it against any other claim the normal way. So `runId` here is not a
 * write trigger; it is the only place a dispatched run's id is ever visible to the hub at all, and
 * it is what Milestone D's relay (which streams events BY run id) needs to subscribe to the run
 * this dispatch produced.
 *
 * **Sent only after the run actually exists**, not merely after the pre-start checks pass — the
 * target waits for its own `startRun` to return before answering, so this frame is never sent
 * carrying a `runId` nothing yet backs. A `startRun` that throws AFTER those checks pass answers
 * with `refused: { reason: 'start-failed' }` instead (see that reason's own docblock) — never with
 * `accepted` and never by silently reusing one of the eight pre-start reasons, both of which would
 * misreport why nothing started.
 *
 * **Mutually exclusive with `refused` by construction** (the `.refine` below): one verdict, one
 * reply, matching every other decide-then-answer function in this codebase (`dispatch.ts#offerDispatch`'s
 * own doc comment: "Check, THEN start or refuse — every refusal reason is decided before anything
 * below has any side effect").
 */
export const clusterFreshnessFrameSchema = clusterRepoFreshnessSchema
  .extend({
    type: z.literal('freshness'),
    protocol: clusterProtocolSchema,
    refused: z
      .object({
        dispatchId: z.string().min(1).max(64),
        reason: clusterDispatchRefusalReasonSchema,
        /** Which corpus, which label, which branch — specific, never prose the UI must parse. */
        detail: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
    /** D48/C-a2 — see this schema's own docblock. Present only on the reply to a dispatch this
     *  target just started, after `startRun` returned. */
    accepted: z
      .object({
        dispatchId: z.string().min(1).max(64),
        /** The run this dispatch produced — what Milestone D's relay keys on, and the only way
         *  the hub learns which run a dispatch became. Same bound as `ClusterActiveRun.runId` /
         *  `ClusterRelayRequestFrame.runId`. */
        runId: z.string().min(1).max(120),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((frame) => !(frame.refused && frame.accepted), {
    message: 'a freshness reply carries `refused` or `accepted`, never both',
  });
export type ClusterFreshnessFrame = z.infer<typeof clusterFreshnessFrameSchema>;

/** → spoke to hub: the heartbeat the scheduler places from. Capacity is a CLAIM; the hub stamps it
 *  with arrival time and the cockpit renders its age. */
export const clusterPresenceFrameSchema = z
  .object({
    type: z.literal('presence'),
    protocol: clusterProtocolSchema,
    capacity: clusterCapacitySchema,
    hostMetrics: hostMetricsResponseSchema.optional(),
    repoDrift: z.array(clusterRepoFreshnessSchema).max(200),
    corpus: clusterCorpusStatusSchema.optional(),
    /** In-flight runs, so `GET /cluster/active` and the overlap refusal read one definition of
     *  "active" rather than two that drift. */
    active: z.array(clusterActiveRunSchema).max(200).optional(),
  })
  .strict();
export type ClusterPresenceFrame = z.infer<typeof clusterPresenceFrameSchema>;

/**
 * ← hub to spoke: the demand signal for D9's on-demand relay. ~146 MB of run NDJSON crosses a
 * single active day and one run can be 25.7 MB, so events are relayed **only while at least one
 * viewer is subscribed** — the same 0→1 / 1→0 discipline `server/ws.ts` already implements for
 * cockpit topics.
 */
export const clusterRelayRequestFrameSchema = z
  .object({
    type: z.literal('relay'),
    protocol: clusterProtocolSchema,
    runId: z.string().min(1).max(120),
    subscribe: z.boolean(),
  })
  .strict();
export type ClusterRelayRequestFrame = z.infer<typeof clusterRelayRequestFrameSchema>;

/** → spoke to hub: the events themselves, while watched. At terminal status the spoke ships a
 *  BOUNDED tail — the last N events plus the handoff markdown — so the hub's board can render a
 *  finished foreign run without ever holding the firehose. */
export const clusterRelayFrameSchema = z
  .object({
    type: z.literal('relay'),
    protocol: clusterProtocolSchema,
    runId: z.string().min(1).max(120),
    /** Open by construction: a run event is `z.looseObject` in `./events.ts` and stays that way
     *  across the link. */
    events: z.array(z.record(z.string(), z.unknown())).max(1_000),
    /** The terminal tail, not a live slice. */
    final: z.boolean().optional(),
    /** True when events were dropped to stay inside `CLUSTER_FRAME_MAX_BYTES` — distinguished from
     *  a complete stream, never silently equivalent to it. */
    truncated: z.boolean().optional(),
    handoffMarkdown: z.string().max(200_000).optional(),
  })
  .strict();
export type ClusterRelayFrame = z.infer<typeof clusterRelayFrameSchema>;

/** Spoke → hub. */
export const clusterUplinkFrameSchema = z.discriminatedUnion('type', [
  clusterHelloFrameSchema,
  clusterOpsFrameSchema,
  clusterFreshnessFrameSchema,
  clusterPresenceFrameSchema,
  clusterRelayFrameSchema,
]);
export type ClusterUplinkFrame = z.infer<typeof clusterUplinkFrameSchema>;

/** Hub → spoke. */
export const clusterDownlinkFrameSchema = z.discriminatedUnion('type', [
  clusterWelcomeFrameSchema,
  clusterRefuseFrameSchema,
  clusterAckFrameSchema,
  clusterReplicaFrameSchema,
  clusterDispatchFrameSchema,
  clusterRelayRequestFrameSchema,
]);
export type ClusterDownlinkFrame = z.infer<typeof clusterDownlinkFrameSchema>;

// ---- the stored roster file (`~/.cezar/cluster/peers.json`) ------------------------------------

export const storedClusterPeersSchema = z
  .object({
    nodes: z.array(storedClusterNodeSchema).default([]),
    pairings: z.array(storedClusterPairingSchema).default([]),
  })
  .passthrough();
export type StoredClusterPeers = z.infer<typeof storedClusterPeersSchema>;

export const storedClusterWatermarksSchema = z
  .object({ watermarks: z.array(storedClusterWatermarkSchema).default([]) })
  .passthrough();
export type StoredClusterWatermarks = z.infer<typeof storedClusterWatermarksSchema>;

/** The open half of the same shape — `~/.cezar/cluster/runs-remote.json`, `.passthrough()` at
 *  every layer so a newer node's projection survives an older node's read intact (D13). */
export const storedClusterRemoteRunSchema = clusterRemoteRunSchema.passthrough();
export type StoredClusterRemoteRun = z.infer<typeof storedClusterRemoteRunSchema>;

/** One node's entry in the report envelope below. Named (rather than inlined in the `z.record`)
 *  for the same reason `storedClusterRemoteRunSchema` is: the reader salvages this file PER ENTRY,
 *  so it needs a parser for a single entry — a whole-record `safeParse` fails atomically on the
 *  first bad one and would take every other node's freshness down with it (D13). */
export const storedClusterRemoteRunReportSchema = z.object({ reportedAt: z.string() }).passthrough();
export type StoredClusterRemoteRunReport = z.infer<typeof storedClusterRemoteRunReportSchema>;

export const storedClusterRemoteRunsSchema = z
  .object({
    runs: z.array(storedClusterRemoteRunSchema).default([]),
    /**
     * Per-node report envelope — what `runs` alone cannot say.
     *
     * Without it, "this node has never reported" and "this node reported and had nothing running"
     * are the same observation: zero rows carrying that `nodeId`. They are not the same fact, and a
     * board that renders them identically tells a viewer a node is idle when it may simply be gone.
     * With it there are three distinguishable states, not one:
     *
     *  - no `nodes` entry ................. never tracked; say nothing about that node
     *  - an entry, and no rows ............ reported, and genuinely had nothing in flight
     *  - an entry, and rows ............... those rows are as of `reportedAt`, however old that is
     *
     * `reportedAt` is stamped from the ARRIVAL of the frame that carried the rows and passed in to
     * `applyRemoteRuns` — never computed at write time and never at read time. A freshness field
     * that reads its own clock reports when it was LOOKED AT, which always looks fresh and is the
     * exact defect that ships when this is left to a default.
     *
     * An entry is never pruned when a node reports zero rows: that is the second state above, and
     * dropping the entry would collapse it back into the first.
     */
    nodes: z.record(clusterNodeIdSchema, storedClusterRemoteRunReportSchema).optional(),
  })
  .passthrough();
export type StoredClusterRemoteRuns = z.infer<typeof storedClusterRemoteRunsSchema>;
