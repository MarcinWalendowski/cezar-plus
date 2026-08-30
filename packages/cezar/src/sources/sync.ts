import { createHash } from 'node:crypto';
import {
  mirroredDocumentSchema,
  sourceStateSchema,
  type MirroredDocument,
  type SourceConnection,
  type SourcePageCursor,
  type SourceSink,
  type SourceState,
  type SourceSyncState,
} from './types.ts';
import type { SourceCommentEntry, SourceDocumentRef, SourceProvider } from './provider-types.ts';
import type { SourceStore } from './store.ts';

/**
 * The resumable sweep (F2, W4.4). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` ("The sweep, step by step") and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D1..D25.
 *
 * **Tombstoning is EXPLICIT-signal-based, not absence-diffing.** The spec's step 9 describes
 * "documents present in the mirror, absent from the exhaustive enumeration", read literally that
 * would mean diffing `sink.list()` against every externalId a poll happened to mention. That is not
 * something this file can build correctly against the landed `SourceProvider` seam: `pollChanges`
 * is a WATERMARK-FILTERED delta (spec step 5's own "once per changed candidate" cost model depends
 * on that), so an unchanged-but-still-live document legitimately never appears in `changes[]`. Its
 * absence from one tick's delta is not evidence of deletion. `SourceChangePage.changes` DOES carry
 * an explicit `{type:'tombstone', externalId}` variant precisely for this (and the landed
 * `notion/provider.ts` emits it whenever Notion reports `row.archived: true`), so this sweep treats
 * that explicit signal as the ONLY tombstone trigger. It still gates ACTING on that signal behind
 * `allComplete` (spec step 9's "only when every collection returned complete: true" reads as a
 * blanket policy on touching deletion state at all, not one scoped to an absence-diff specifically).
 * A tombstone signal seen on an incomplete pass is buffered for the duration of that ONE tick and
 * discarded, never carried into a later tick (there is no field on `sourceStateSchema`, W1.5, not
 * this package's file, to persist a pending-tombstone set across ticks). A document flagged this way
 * is picked up again whenever a LATER tick's own poll happens to re-report it.
 *
 * **Backoff is exponential with provider lower bounds.** `SourceChangePage` and
 * `SourceCommentPage` carry an optional `retryAfterMs` lower bound across the provider seam. This
 * file distinguishes "the call budget stopped us" (`truncated: true`, no backoff, just resume) from
 * "a request actually failed" (`truncated: false`, exponential backoff with full jitter), while
 * ensuring a provider's retry hint is never shortened.
 *
 * **`docId`'s "workspaceId" is `connection.id`.** The spec's Q12 formula is
 * `sha256(kind + ':' + workspaceId + ':' + externalId)`; `SourceConnection` (W1.5) carries no
 * `workspaceId` field, and each connection's mirror already lives in its own
 * `sources/<connectionId>/` directory (`sink.ts`), so a docId only needs to be collision-free
 * WITHIN one connection. `connection.id` stands in for `workspaceId`.
 */

const DEFAULT_CALL_BUDGET = 25;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CEILING_MS = 6 * 60 * 60_000;

export interface SourceSyncOptions {
  connection: SourceConnection;
  store: SourceStore;
  sink: SourceSink;
  provider: SourceProvider;
  /** The F1 knowledge mount root this connection's mirror lives under,
   *  `<repoRoot>/.ai/cezar/sources` (D3), forwarded verbatim to `sink.notifyChanged` after every
   *  commit (D15/D25). Not derived from `sink`: the `SourceSink` port exposes no path accessor. */
  mirrorRoot: string;
  /** One shared HTTP call budget across all collections and comment pages in this tick. */
  callBudget?: number;
  now?: () => Date;
}

export interface SourceSyncResult {
  /** `false` when the lease was held, or the connection was disabled, archived, or backed off. */
  ran: boolean;
  syncState: SourceSyncState;
  reason?: string;
  documentCount: number;
  conflictCount: number;
  tombstoneCount: number;
  /** Whether EVERY collection reached exhaustion this tick, from the resume point onward. */
  complete: boolean;
}

export async function runSourceSync(options: SourceSyncOptions): Promise<SourceSyncResult> {
  const { connection, store } = options;
  const now = options.now ?? (() => new Date());

  // Step 1: lease. Held means this tick returns immediately, copying `automations/store.ts`'s
  // `O_EXCL` lease idiom (W1.5's `store.ts` already implements `acquireLease`).
  const lease = store.acquireLease();
  if (!lease) return notRunResult(store.state(connection.id), 'lease-held');

  try {
    // A manual route and the background scheduler can be separate processes. The poll lease
    // serializes them, and this reload makes the winner's sweep start from the newest definitions.
    store.reload();
    const currentConnection = store.get(connection.id);
    if (!currentConnection) return notRunResult(store.state(connection.id), 'connection-removed');
    return await sweep({ ...options, connection: currentConnection }, now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const nowIso = now().toISOString();
    store.updateState(connection.id, {
      syncState: 'error',
      syncStateAt: nowIso,
      lastError: { at: nowIso, message },
    });
    store.appendLog({ connectionId: connection.id, event: 'error', message });
    const state = store.state(connection.id)!;
    return {
      ran: true,
      syncState: 'error',
      reason: message,
      documentCount: state.documentCount,
      conflictCount: state.conflictCount,
      tombstoneCount: state.tombstoneCount,
      complete: false,
    };
  } finally {
    lease.release();
    store.maybeCompact();
  }
}

function notRunResult(state: SourceState | undefined, reason?: string): SourceSyncResult {
  return {
    ran: false,
    syncState: state?.syncState ?? 'never-synced',
    ...(reason ? { reason } : {}),
    documentCount: state?.documentCount ?? 0,
    conflictCount: state?.conflictCount ?? 0,
    tombstoneCount: state?.tombstoneCount ?? 0,
    complete: false,
  };
}

async function sweep(options: SourceSyncOptions, now: () => Date): Promise<SourceSyncResult> {
  const { connection, store, sink, provider } = options;
  const id = connection.id;
  const nowIso = () => now().toISOString();

  // Step 2: skip. `syncState` is left untouched, this tick never happened.
  const priorState = store.state(id) ?? sourceStateSchema.parse({});
  if (!connection.enabled) return notRunResult(priorState, 'disabled');
  if (connection.mode === 'archived') return notRunResult(priorState, 'archived');
  if (priorState.backoffUntil && Date.parse(priorState.backoffUntil) > now().getTime()) {
    return notRunResult(priorState, 'backoff');
  }

  store.updateState(id, { lastAttemptAt: nowIso() });

  // Step 3: probe. Never throws for an expected absence (forge/Notion-client convention). A
  // revoked token freezes the mirror in place rather than emptying it (spec Edge Cases, NC-2): no
  // document is touched below and no count is recomputed on this branch.
  const availability = await provider.detect();
  if (!availability.available) {
    const state = store.updateState(id, {
      syncState: 'unavailable',
      syncStateAt: nowIso(),
      lastError: {
        at: nowIso(),
        message: availability.reason ?? 'source unavailable',
      },
    });
    store.appendLog({
      connectionId: id,
      event: 'unavailable',
      message: availability.reason,
    });
    return {
      ran: true,
      syncState: 'unavailable',
      reason: availability.reason,
      documentCount: state.documentCount,
      conflictCount: state.conflictCount,
      tombstoneCount: state.tombstoneCount,
      complete: false,
    };
  }

  // Steps 4-9: enumerate every collection from the persisted resume point, diff-before-fetch,
  // convert, write, quarantine, and (gated) tombstone.
  const collections = await provider.listCollections();
  const startIndex = priorState.pageCursor
    ? Math.max(
        0,
        collections.findIndex((collection) => collection.externalId === priorState.pageCursor!.collectionExternalId),
      )
    : 0;

  const watermarks = { ...priorState.watermarks };
  let allComplete = true;
  let newPageCursor: SourcePageCursor | undefined;
  let errorOccurred = false;
  let errorMessage: string | undefined;
  let retryAfterMs: number | undefined;
  let remainingBudget = options.callBudget ?? DEFAULT_CALL_BUDGET;
  const changedDocIds: string[] = [];
  const tombstoneCandidates: Array<{ docId: string; externalId: string }> = [];

  for (let i = startIndex; i < collections.length; i++) {
    const collection = collections[i]!;
    if (remainingBudget <= 0) {
      allComplete = false;
      newPageCursor = { collectionExternalId: collection.externalId, cursor: '' };
      break;
    }
    const resumeCursor = i === startIndex ? (priorState.pageCursor?.cursor ?? null) : null;
    const page = await provider.pollChanges(watermarks[collection.externalId] ?? null, {
      collectionExternalId: collection.externalId,
      cursor: resumeCursor,
      callBudget: remainingBudget,
    });
    remainingBudget -= page.callsUsed ?? remainingBudget;
    retryAfterMs = Math.max(retryAfterMs ?? 0, page.retryAfterMs ?? 0) || undefined;

    for (const change of page.changes) {
      if (change.type === 'upsert') {
        const outcome = await processUpsert(options, change.doc, now);
        if (outcome.kind !== 'skipped') changedDocIds.push(outcome.docId);
      } else {
        tombstoneCandidates.push({
          docId: computeDocId(connection, change.externalId),
          externalId: change.externalId,
        });
      }
    }

    if (page.complete) {
      if (page.watermark) watermarks[collection.externalId] = page.watermark;
    } else {
      allComplete = false;
      if (page.nextPageCursor) {
        newPageCursor = {
          collectionExternalId: collection.externalId,
          cursor: page.nextPageCursor,
        };
      }
      if (!page.truncated) {
        errorOccurred = true;
        errorMessage = `enumeration failed for collection "${collection.externalId}"`;
      }
      if (page.retryAfterMs !== undefined) {
        errorOccurred = true;
        errorMessage = `enumeration retry requested for collection "${collection.externalId}"`;
      }
      break;
    }
  }

  const commentSweep = await sweepComments(options, priorState, now, remainingBudget);
  remainingBudget = commentSweep.remainingBudget;
  if (commentSweep.retryAfterMs !== undefined) {
    retryAfterMs = Math.max(retryAfterMs ?? 0, commentSweep.retryAfterMs) || undefined;
  }
  if (commentSweep.errorMessage) {
    errorOccurred = true;
    errorMessage = commentSweep.errorMessage;
  }

  // Step 9: tombstone, gated on the WHOLE tick's walk (resume point to the end) having completed.
  // See this file's header for why this acts on explicit tombstone signals rather than diffing.
  let tombstonesThisTick = 0;
  if (allComplete) {
    for (const candidate of tombstoneCandidates) {
      if (store.isAdopted(id, candidate.externalId) || store.isTombstonedExternal(id, candidate.externalId)) continue;
      await sink.tombstone(candidate.docId, nowIso());
      store.tombstoneExternal(id, candidate.externalId);
      changedDocIds.push(candidate.docId);
      tombstonesThisTick += 1;
    }
  }

  // Step 10: commit.
  const metas = await sink.list(id);
  const commitIso = nowIso();
  const patch: Partial<SourceState> = {
    watermarks,
    pageCursor: newPageCursor,
    lastSuccessAt: errorOccurred ? priorState.lastSuccessAt : commitIso,
    ...(allComplete ? { lastCompleteSweepAt: commitIso } : {}),
    documentCount: metas.length,
    conflictCount: metas.filter((meta) => meta.source.state === 'conflict').length,
    tombstoneCount: (priorState.tombstoneCount ?? 0) + tombstonesThisTick,
    syncState: errorOccurred ? 'error' : 'ok',
    syncStateAt: commitIso,
    commentWatermarks: commentSweep.commentWatermarks,
    commentPageCursors: commentSweep.commentPageCursors,
    commentSweepAt: commentSweep.commentSweepAt,
    unresolvedComments: priorState.unresolvedComments + commentSweep.addedComments,
    backoffUntil: undefined,
    lastError: undefined,
  };
  if (errorOccurred) {
    const backoffMs = nextBackoffMs(priorState, retryAfterMs);
    patch.backoffUntil = new Date(now().getTime() + backoffMs).toISOString();
    patch.lastError = {
      at: commitIso,
      message: errorMessage ?? 'source enumeration failed',
    };
  }
  const state = store.updateState(id, patch);
  store.appendLog({
    connectionId: id,
    event: errorOccurred ? 'error' : allComplete ? 'complete' : 'partial',
    message: errorMessage,
  });

  // D15/D25: required after every sweep commit, never best effort.
  sink.notifyChanged(options.mirrorRoot, changedDocIds.length ? changedDocIds : undefined);

  return {
    ran: true,
    syncState: state.syncState,
    reason: errorMessage,
    documentCount: state.documentCount,
    conflictCount: state.conflictCount,
    tombstoneCount: state.tombstoneCount,
    complete: allComplete,
  };
}

type UpsertOutcome = { kind: 'written' | 'conflict'; docId: string } | { kind: 'skipped' };

interface CommentSweepResult {
  commentWatermarks: Record<string, string>;
  commentPageCursors: Record<string, string>;
  commentSweepAt: Record<string, string>;
  addedComments: number;
  remainingBudget: number;
  retryAfterMs?: number;
  errorMessage?: string;
}

async function sweepComments(
  options: SourceSyncOptions,
  priorState: SourceState,
  now: () => Date,
  budget: number,
): Promise<CommentSweepResult> {
  const { connection, store, sink, provider } = options;
  const commentWatermarks = { ...priorState.commentWatermarks };
  const commentPageCursors = { ...priorState.commentPageCursors };
  const commentSweepAt = { ...priorState.commentSweepAt };
  if (!connection.watchComments || !provider.capabilities.comments || !provider.listComments || budget <= 0) {
    return {
      commentWatermarks,
      commentPageCursors,
      commentSweepAt,
      addedComments: 0,
      remainingBudget: budget,
    };
  }

  const metas = await sink.list(connection.id);
  metas.sort((a, b) => {
    const left = Date.parse(commentSweepAt[a.docId] ?? '') || 0;
    const right = Date.parse(commentSweepAt[b.docId] ?? '') || 0;
    return left - right || a.docId.localeCompare(b.docId);
  });
  let remainingBudget = budget;
  let addedComments = 0;
  let retryAfterMs: number | undefined;
  let errorMessage: string | undefined;

  for (const meta of metas) {
    if (remainingBudget <= 0) break;
    const ref: SourceDocumentRef = {
      externalId: meta.source.externalId,
      collectionExternalId: meta.collectionExternalId,
      ...(meta.parentExternalId ? { parentExternalId: meta.parentExternalId } : {}),
      title: meta.title,
      url: meta.source.url,
      remoteVersion: meta.remoteVersionSeen ?? meta.source.remoteVersion,
      docType: meta.docType,
      properties: meta.properties,
    };
    const page = await provider.listComments(ref, commentWatermarks[meta.docId], {
      cursor: commentPageCursors[meta.docId] ?? null,
      callBudget: remainingBudget,
    });
    remainingBudget -= page.callsUsed ?? remainingBudget;
    retryAfterMs = Math.max(retryAfterMs ?? 0, page.retryAfterMs ?? 0) || undefined;
    const added = store.appendComments(connection.id, meta.docId, page.comments as SourceCommentEntry[]);
    addedComments += added.length;

    if (page.complete) {
      delete commentPageCursors[meta.docId];
      const latest = page.comments.reduce<string | undefined>(
        (current, comment) => (!current || comment.createdAt > current ? comment.createdAt : current),
        commentWatermarks[meta.docId],
      );
      if (latest) commentWatermarks[meta.docId] = latest;
      commentSweepAt[meta.docId] = now().toISOString();
    } else {
      if (page.nextPageCursor) commentPageCursors[meta.docId] = page.nextPageCursor;
      if (!page.truncated || page.retryAfterMs !== undefined) {
        errorMessage = `comment enumeration failed for document "${meta.docId}"`;
      }
      break;
    }
  }

  return {
    commentWatermarks,
    commentPageCursors,
    commentSweepAt,
    addedComments,
    remainingBudget,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

async function processUpsert(
  options: SourceSyncOptions,
  ref: SourceDocumentRef,
  now: () => Date,
): Promise<UpsertOutcome> {
  const { connection, sink, provider } = options;
  const docId = computeDocId(connection, ref.externalId);

  const existingMeta = await sink.readMeta(docId);
  if (existingMeta && existingMeta.source.externalId !== ref.externalId) {
    // Q12 edge case: a collision on the truncated hash is a hard error, never a silent overwrite.
    throw new Error(
      `source document id collision: "${existingMeta.source.externalId}" and "${ref.externalId}" both hash to docId "${docId}"`,
    );
  }

  // Step 5: diff before fetch, this is what keeps the steady state cheap (spec "Research").
  if (existingMeta?.remoteVersionSeen === ref.remoteVersion) return { kind: 'skipped' };

  // Step 6: convert. `fetchDocument` never throws (provider contract): a transient failure comes
  // back `null` and is simply retried next tick.
  const document = await provider.fetchDocument(ref);
  if (!document) return { kind: 'skipped' };

  // Step 8: quarantine, detected BEFORE writing: a write would overwrite the evidence of a local
  // edit. Reaching this point already means the remote side changed (the step-5 skip above would
  // have fired otherwise), so only the LOCAL side needs checking here.
  if (existingMeta) {
    const stored = await sink.read(docId);
    const locallyEdited =
      stored !== null && existingMeta.localVersion !== undefined && stored.localVersion !== existingMeta.localVersion;
    if (locallyEdited) {
      await sink.quarantine(docId, ref.remoteVersion, document.body);
      return { kind: 'conflict', docId };
    }
  }

  // Step 7: write.
  const doc: MirroredDocument = mirroredDocumentSchema.parse({
    docId,
    title: document.title,
    source: {
      kind: connection.kind,
      connectionId: connection.id,
      externalId: document.externalId,
      url: provider.viewUrl(document) ?? document.url,
      remoteVersion: document.remoteVersion,
      origin: 'remote',
      state: 'ok',
      mirroredAt: now().toISOString(),
      lossy: document.lossy,
    },
    collectionExternalId: document.collectionExternalId,
    parentExternalId: document.parentExternalId,
    docType: document.docType,
    remoteVersionSeen: document.remoteVersion,
    properties: document.properties,
    unresolvedComments: existingMeta?.unresolvedComments ?? 0,
  });
  await sink.upsert(doc, document.body);
  return { kind: 'written', docId };
}

/** Q12: the provider's opaque id, hashed. See this file's header for the `workspaceId` ->
 *  `connection.id` substitution. */
export function computeDocId(connection: Pick<SourceConnection, 'kind' | 'id'>, externalId: string): string {
  return createHash('sha256')
    .update(`${connection.kind}:${connection.id}:${externalId}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * Full jitter (spec "exponential from 60s doubling to a 6h ceiling with full jitter"): the delay is
 * `random(0, cap)`, where `cap` doubles on each consecutive failure. There is no
 * `consecutiveFailures` counter on `sourceStateSchema` (W1.5, not this package's file) to extend
 * cleanly, so the previous cap is reconstructed from the delta between the last `backoffUntil` and
 * the `lastError` that set it, zero when there was no prior backoff, which starts the sequence at
 * the 60s base.
 */
function nextBackoffMs(state: SourceState, retryAfterMs = 0): number {
  const previousCapMs =
    state.backoffUntil && state.lastError
      ? Math.max(0, Date.parse(state.backoffUntil) - Date.parse(state.lastError.at))
      : 0;
  const cap = Math.min(BACKOFF_CEILING_MS, previousCapMs > 0 ? previousCapMs * 2 : BACKOFF_BASE_MS);
  const lowerBound = Math.max(0, retryAfterMs);
  if (lowerBound >= cap) return lowerBound;
  return lowerBound + Math.floor(Math.random() * (cap - lowerBound));
}
