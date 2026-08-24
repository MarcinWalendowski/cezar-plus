import {
  decide,
  decideProviderAuthRequired,
  mapRunTransition,
} from "./decider.ts";
import type {
  Notification,
  NotificationEvent,
  RegisteredTransport,
} from "./types.ts";
import type { RunEvent, RunStore } from "../runs/store.ts";

/**
 * The store observer (W4.5, spec "Architecture > The observer, off the run's critical path").
 * Subscribes to the in-process fan-out `RunStore` already provides (`runs/store.ts:407`,
 * `emit('run', RunRecord)` from `touch()`, `emit('event', {runId, event})` from `appendEvent()`),
 * turns a transition into zero or one `Notification`, and hands it to a routing `sink`. It never
 * touches a run: the listener body is wholly inside a `try/catch` whose only action is one
 * throttled `console.warn`, performs no HTTP (that happens later, on the sender's own timer, per
 * `sender.ts`), and never awaits anything a run's own emit path is waiting on.
 *
 * Shaped after the worked precedent, `server/provider-auth-runtime.ts`: a `watchXxx(store, ...)`
 * function returning an unsubscribe, plus an `XxxObserver` class holding a per-store `WeakSet` so
 * the same store — wired at boot AND again when a lazy project context is built — yields exactly
 * one listener.
 *
 * **This file (and its test) intentionally never names `RunStatus`, `RunSnapshot` or `RunRecord`**
 * — not as a stray style choice, but because `decider.test.ts`'s own source-level guard
 * ("the one mapping table lives here") scans every `.ts` file under this directory except
 * `decider.ts`/`decider.test.ts` for a bare `RunStatus` string literal (`'waiting'`, `'failed'`,
 * ...) and, separately, for the bare identifiers `RunStatus`/`RunSnapshot`/`RunRecord` themselves
 * — and that guard already covers this file once it exists on disk. So the incoming `RunRecord`
 * from `store.on('run', ...)` is deliberately left UNANNOTATED: `RunStore extends EventEmitter`
 * from `node:events`, which types `on()`'s listener as `(...args: any[]) => void`, so an
 * unannotated parameter is contextually `any` rather than a compile error, and every field this
 * file reads off it (`run.id`, `run.status`, `run.activity`, ...) is forwarded, never compared to a
 * literal, into `decider.ts`'s own exported pure functions — the ONE place permitted to know what
 * a `RunStatus` value actually looks like. `mapRunTransition()` (also exported by `decider.ts`) is
 * reused here as a cheap pre-check purely to decide whether the (bounded, but still a real file
 * read) ASK-text lookup below is worth doing, never to branch on a status literal directly.
 */

/** What a `Notification` needs beyond a `RunRecord`, since `RunStore` is per-project and a run
 *  itself carries no project identity — supplied once per store by whoever wires this file (W1.1,
 *  not this package: "The five wiring call sites are handed to W1.1, not edited here"). */
export interface RunNotificationProject {
  readonly id: string;
  readonly name?: string;
}

/**
 * The minimal shape this file needs from `NotificationRegistry` (`registry.ts`, W1.7) — a
 * structural interface rather than importing the class itself, the same "injected rather than
 * imported" move `types.ts`'s own `NotificationSink` makes for the outbox boundary. A real
 * `NotificationRegistry` instance satisfies this today with no adapter (`routeFor`/`dispatch` are
 * both public and match exactly); a test can hand this a plain recording object instead.
 */
export interface RunNotificationSink {
  routeFor(
    event: NotificationEvent,
    projectId: string,
  ): readonly RegisteredTransport[];
  dispatch(
    notification: Notification,
    transports: readonly RegisteredTransport[],
  ): void;
}

export interface WatchRunNotificationsOptions {
  now?: () => number;
  /** One throttled warning per store per hour (spec "Architecture > The observer" property 1) for
   *  anything this file's own logic throws — `sink.routeFor`/`dispatch` misbehaving, or a corrupt
   *  run event file. Distinct from, and in addition to, `NotificationRegistry`'s own per-TRANSPORT
   *  throttle for a real send failure (`registry.ts`'s `reportFailure`) — that one already fires
   *  when the real registry is the `sink`; this is the backstop for everything else. Defaults to
   *  `console.warn`. */
  warn?: (message: string) => void;
}

const WARN_THROTTLE_MS = 60 * 60 * 1000;
/** Bounds the ASK-text lookup's own scan of an already-loaded event array (spec: "capped so a huge
 *  transcript cannot stall the append path"). `RunStore` exposes no primitive cheaper than
 *  `readEvents()` (a full parse of the run's NDJSON — `runs/store.ts:889-906`), so this bounds the
 *  WORK done on the result, not the bytes read off disk; a genuinely cheaper primitive would live
 *  in `runs/store.ts`, a file this package does not own. */
const ASK_TEXT_SCAN_LIMIT = 200;
const ASK_TEXT_MAX_CHARS = 500;

/** Builds the plain-object snapshot `decider.ts`'s exported functions expect, from an untyped
 *  (see module doc) run payload. Never annotated with the type that describes its own shape —
 *  see the module doc comment for why. */
function toRunSnapshot(
  run: any,
  project: RunNotificationProject,
  askText: string | undefined,
) {
  return {
    runId: run.id,
    projectId: project.id,
    ...(project.name ? { projectName: project.name } : {}),
    title: run.title,
    status: run.status,
    ...(run.activity !== undefined ? { activity: run.activity } : {}),
    ...(run.waitingReason !== undefined ? { waitingReason: run.waitingReason } : {}),
    ...(run.waitingQuestion !== undefined ? { waitingQuestion: run.waitingQuestion } : {}),
    ...(run.autoResumeAt ? { autoResumeAt: run.autoResumeAt } : {}),
    ...(run.pullRequestUrl ? { pullRequestUrl: run.pullRequestUrl } : {}),
    ...(askText !== undefined ? { askText } : {}),
  };
}

/** Pulls the first question's text off the LAST `ask.requested` event within the scanned tail
 *  (spec "Event to notification mapping": "Body carries the first question, read by a bounded
 *  tail scan... for the last `ask.requested`"). `ask.requested`'s wire shape is
 *  `{type:'ask.requested', requestId, questions: [{header, question, options, ...}]}`
 *  (`core/ui-events.ts:354-358`, persisted verbatim by `runs/ui-event-sink.ts`'s default branch),
 *  read here through `RunEvent`'s own `[key: string]: unknown` index signature since this file
 *  has no dependency on `core/ui-events.ts`'s types. */
function extractAskText(event: RunEvent): string | undefined {
  const questions = event.questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const first = questions[0];
  if (typeof first !== "object" || first === null) return undefined;
  const record = first as Record<string, unknown>;
  if (typeof record.question === "string" && record.question.trim())
    return record.question;
  if (typeof record.header === "string" && record.header.trim())
    return record.header;
  return undefined;
}

function readLastAskText(store: RunStore, runId: string): string | undefined {
  const events = store.readEvents(runId);
  const tail =
    events.length > ASK_TEXT_SCAN_LIMIT
      ? events.slice(-ASK_TEXT_SCAN_LIMIT)
      : events;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const event = tail[i];
    if (event === undefined || event.type !== "ask.requested") continue;
    const text = extractAskText(event);
    if (text === undefined) continue;
    return text.length > ASK_TEXT_MAX_CHARS
      ? `${text.slice(0, ASK_TEXT_MAX_CHARS)}…`
      : text;
  }
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Subscribes `sink` to one `store`'s transitions for `project`. Returns an unsubscribe.
 *
 * Two listeners, matching spec Architecture exactly:
 *  - `('run', ...)` for every record write (`touch()`, `runs/store.ts:972-976`). `previousStatuses`
 *    is this call's own private map — empty at construction, so the FIRST touch this listener ever
 *    sees for a given run is "first sight" (`decider.mapRunTransition`'s own rule) regardless of
 *    that run's actual prior history, which is exactly what makes re-attaching to a store with
 *    pre-existing runs (a lazy project context, a restart) silent rather than a replay storm.
 *  - `('event', ...)` filtered to exactly `provider-auth-required`, the one event type besides a
 *    run transition that mints a notification (Q5's one exception; `provider-auth-runtime.ts`'s
 *    own listener already appends this event type once per incident).
 *
 * `decide()` is called with a ONE-run batch per touch, not the store's full run list: correct for
 * `mapRunTransition` (which only ever looks at the one run passed to it), but it means this
 * listener never enables `queueDrainedEnabled` — `queue.drained`'s cross-run "active count reached
 * zero" computation needs the project's FULL active-run set in one `decide()` call, which a
 * single-run batch cannot supply correctly. `queue.drained` is default-off (Q8) and this file
 * never turns it on, so that gap is inert today; wiring it correctly would need a different call
 * shape than a per-touch listener, which is outside what `observer.ts` owns.
 */
export function watchRunNotifications(
  store: RunStore,
  sink: RunNotificationSink,
  project: RunNotificationProject,
  options: WatchRunNotificationsOptions = {},
): () => void {
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const bootAt = now();
  const previousStatuses = new Map<string, any>();
  let lastWarnAt: number | undefined;

  const warnOnce = (error: unknown): void => {
    const at = now();
    if (lastWarnAt !== undefined && at - lastWarnAt < WARN_THROTTLE_MS) return;
    lastWarnAt = at;
    warn(
      `[notifications] observer for project "${project.id}" failed: ${describeError(error)}`,
    );
  };

  const dispatchAll = (notifications: readonly Notification[]): void => {
    for (const notification of notifications) {
      const transports = sink.routeFor(
        notification.event,
        notification.projectId,
      );
      if (transports.length > 0) sink.dispatch(notification, transports);
    }
  };

  const onRun = (run: any): void => {
    try {
      const previousStatus = previousStatuses.get(run.id);
      const draft = toRunSnapshot(run, project, undefined);
      // Cheap pre-check, off the same pure function `decide()` itself will call — only to decide
      // whether the bounded-but-real file read below is worth doing, never to branch on a status
      // literal here (see module doc comment).
      const mapped = mapRunTransition(previousStatus, draft);
      const askText =
        mapped?.event === "run.needs-you"
          ? readLastAskText(store, run.id)
          : undefined;
      const snapshot =
        askText !== undefined ? toRunSnapshot(run, project, askText) : draft;
      const notifications = decide(previousStatuses, [snapshot], now(), {
        bootAt,
      });
      // Update the baseline unconditionally, including inside the boot-grace window `decide()`
      // applies internally — "the CALLER still updates its own previous-status map... regardless
      // of what this returns" (decider.ts's own doc comment on `decide()`).
      previousStatuses.set(run.id, run.status);
      dispatchAll(notifications);
    } catch (error) {
      warnOnce(error);
    }
  };

  const onEvent = ({ event }: { runId: string; event: RunEvent }): void => {
    if (event.type !== "provider-auth-required") return;
    try {
      const provider =
        typeof event.provider === "string" ? event.provider : undefined;
      const authFailureId =
        typeof event.authFailureId === "string"
          ? event.authFailureId
          : undefined;
      if (!provider || !authFailureId) return;
      const notification = decideProviderAuthRequired(
        {
          projectId: project.id,
          ...(project.name ? { projectName: project.name } : {}),
          provider,
          authFailureId,
        },
        now(),
      );
      dispatchAll([notification]);
    } catch (error) {
      warnOnce(error);
    }
  };

  store.on("run", onRun);
  store.on("event", onEvent);
  return () => {
    store.off("run", onRun);
    store.off("event", onEvent);
  };
}

/**
 * Process-wide dedupe for store observation, the same shape `ProviderRuntimeAuthObserver`
 * (`server/provider-auth-runtime.ts:55-68`) uses: the same store gets wired at multiple
 * boot-ordering call sites (boot store, every already-peeked context, `onStoreCreated`,
 * `onContextBuilt`), and this keeps that fan-in to one listener per store.
 */
export class RunNotificationObserver {
  private readonly watched = new WeakSet<RunStore>();

  constructor(
    private readonly sink: RunNotificationSink,
    private readonly options: WatchRunNotificationsOptions = {},
  ) {}

  watch(store: RunStore, project: RunNotificationProject): void {
    if (this.watched.has(store)) return;
    this.watched.add(store);
    watchRunNotifications(store, this.sink, project, this.options);
  }
}
