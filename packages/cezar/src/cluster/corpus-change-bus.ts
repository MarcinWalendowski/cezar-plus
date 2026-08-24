/**
 * A process-wide "this node's corpus moved" signal (spec items 57 / 59).
 *
 * **Why a module-level registry rather than a passed dependency.** The two ends of this signal are
 * built in places that cannot see each other and are constructed in the wrong order: the emitter is
 * a per-project `KnowledgeStore` built by `server/project-context.ts#activateOptionalStores` at
 * project activation, and the listener is the hub's corpus broadcaster, built inside
 * `server/cluster-routes.ts#startClusterRuntime`'s async hub branch, after an awaited identity
 * load. Threading a callback from the second into the first would mean routing it through
 * `ServerDeps` and every project-context call site, for one process-wide boolean fact.
 *
 * The scope is deliberately narrow, so the usual objections to a singleton do not apply here: at
 * most ONE listener, replaced not accumulated, and the payload is nothing — it says only *that* the
 * corpus changed, never what. Everything downstream re-reads the authoritative state itself.
 *
 * **This is a hint channel and must stay one.** A listener that never fires, or is never
 * registered, must degrade to "the interval sweep picks it up later", never to "the mirror is
 * stale forever". Nothing may be built on the assumption that an emit was delivered.
 */

type CorpusChangeListener = () => void;

let listener: CorpusChangeListener | undefined;
let warnFn: ((message: string) => void) | undefined;

/**
 * Register the process's corpus-change listener, replacing any previous one. Returns a disposer
 * that clears it **only if it is still the current listener** — a blue-green hub restarts ~10x/day
 * and a late teardown from a superseded runtime must not silently unregister its successor's
 * listener, which would look exactly like a corpus that never changes.
 */
export function setCorpusChangeListener(
  next: CorpusChangeListener,
  options?: { warn?: (message: string) => void },
): () => void {
  listener = next;
  warnFn = options?.warn;
  return () => {
    if (listener === next) {
      listener = undefined;
      warnFn = undefined;
    }
  };
}

/**
 * Emit the signal. A no-op when nothing is registered — the ordinary state on a spoke, on a
 * non-clustered cockpit, and on a hub before its runtime has armed. Never throws: this is called
 * from inside a completed reindex, and a broadcast failure must not fail the indexing that
 * provoked it.
 */
export function emitCorpusChanged(): void {
  const current = listener;
  if (!current) return;
  try {
    current();
  } catch (err) {
    warnFn?.(`cluster: corpus-change listener threw (the index is unaffected): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Test-only reset, so one test's registration cannot leak into the next. */
export function resetCorpusChangeListenerForTests(): void {
  listener = undefined;
  warnFn = undefined;
}
