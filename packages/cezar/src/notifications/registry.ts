import { EVENT_CATALOG } from './decider.ts';
import type {
  DeliveryResult,
  Notification,
  NotificationEvent,
  NotificationSink,
  RegisteredTransport,
} from './types.ts';

/**
 * The registry of transport INSTANCES (plan D11/D23 — never transport types; one generic
 * `webhook` kind, N independently-enabled rows). See spec "Architecture > The registry".
 *
 * Two responsibilities, kept deliberately separate:
 *
 *  - `dispatch()` is the observer's path (W4.5, later): synchronous, off the run's critical
 *    path, never awaits and never throws (W1.7 acceptance). It only reserves outbox rows through
 *    an injected {@link NotificationSink} — the durable outbox itself is W2.5's
 *    (`notifications/outbox.ts`), a sibling this file has no dependency on.
 *  - `send()` is the sender's path (W2.5) and the `/test` route's (W4.7): it actually calls a
 *    transport and wraps the call, because a transport is third-party-shaped code. A synchronous
 *    throw, a rejected promise and (to the extent the transport honors the abort signal it is
 *    handed) a hang are all coerced to `{ok:false, retryable:true}`.
 *
 * Like `decider.ts`, this file must never contain a bare `RunStatus` string literal — it only
 * ever sees `NotificationEvent`/`Severity`, never a run's own status.
 */

const DEFAULT_SEND_TIMEOUT_MS = 10_000;
const WARN_THROTTLE_MS = 60 * 60 * 1000;

export interface NotificationRegistryOptions {
  sink: NotificationSink;
  /** One throttled warning per transport per hour (spec "Architecture > The observer" property
   *  1). Injected so a test can assert on it without stubbing `console`. Defaults to
   *  `console.warn`. */
  warn?: (transportId: string, error: unknown) => void;
  now?: () => number;
}

export class NotificationRegistry {
  private readonly transports = new Map<string, RegisteredTransport>();
  private readonly sink: NotificationSink;
  private readonly warn: (transportId: string, error: unknown) => void;
  private readonly now: () => number;
  private readonly lastWarnAt = new Map<string, number>();

  constructor(options: NotificationRegistryOptions) {
    this.sink = options.sink;
    this.warn = options.warn ?? defaultWarn;
    this.now = options.now ?? Date.now;
  }

  /** Holds instances, not types — registering the same `route.transportId` twice replaces the
   *  prior entry rather than accumulating one. Rejects a mismatched pairing outright: this only
   *  ever runs at config-load/wiring time, never on a run's critical path, so failing loudly here
   *  is cheap and catches a wiring bug before it can silently route to the wrong transport. */
  register(entry: RegisteredTransport): void {
    if (entry.transport.id !== entry.route.transportId) {
      throw new Error(
        `notifications registry: transport id mismatch (transport.id="${entry.transport.id}", route.transportId="${entry.route.transportId}")`,
      );
    }
    this.transports.set(entry.route.transportId, entry);
  }

  unregister(transportId: string): void {
    this.transports.delete(transportId);
  }

  get(transportId: string): RegisteredTransport | undefined {
    return this.transports.get(transportId);
  }

  list(): RegisteredTransport[] {
    return [...this.transports.values()];
  }

  /**
   * The enabled transports whose event matrix and project filter admit `event` for `projectId`.
   * An absent key in a transport's own `events` matrix falls back to `EVENT_CATALOG`'s own
   * default (`decider.ts`, "the one mapping table") rather than a second, locally-duplicated
   * default table.
   */
  routeFor(event: NotificationEvent, projectId: string): RegisteredTransport[] {
    const defaultEnabled = EVENT_CATALOG[event].defaultEnabled;
    const admitted: RegisteredTransport[] = [];
    for (const entry of this.transports.values()) {
      if (!entry.route.enabled) continue;
      const eventEnabled = entry.route.events[event] ?? defaultEnabled;
      if (!eventEnabled) continue;
      if (entry.route.projects && !entry.route.projects.includes(projectId)) continue;
      admitted.push(entry);
    }
    return admitted;
  }

  /**
   * Reserves an outbox row on every given transport and returns immediately — it never awaits a
   * send (HTTP happens later, on the sender timer) and never throws. A synchronously-throwing
   * sink, or one whose returned promise rejects, is caught and folded into the throttled warning
   * instead of propagating: a notification failure must never touch a run.
   */
  dispatch(notification: Notification, transports: readonly RegisteredTransport[]): void {
    for (const entry of transports) {
      const transportId = entry.route.transportId;
      try {
        const result = this.sink.reserve(transportId, notification);
        if (isPromiseLike(result)) {
          result.then(undefined, (error: unknown) => this.reportFailure(transportId, error));
        }
      } catch (error) {
        this.reportFailure(transportId, error);
      }
    }
  }

  /**
   * Sends through one registered transport directly, coercing a synchronous throw, a rejected
   * promise, and (as far as the transport itself honors the `AbortSignal` it is handed) a hang
   * past `timeoutMs`, all into a `DeliveryResult`. Never used by `dispatch()`, which stays
   * synchronous.
   */
  async send(transportId: string, notification: Notification, timeoutMs = DEFAULT_SEND_TIMEOUT_MS): Promise<DeliveryResult> {
    const entry = this.transports.get(transportId);
    if (!entry) {
      return { ok: false, retryable: false, error: `unknown transport: ${transportId}`, durationMs: 0 };
    }
    const startedAt = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await entry.transport.send(notification, controller.signal);
    } catch (error) {
      return {
        ok: false,
        retryable: true,
        error: describeError(error),
        durationMs: this.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private reportFailure(transportId: string, error: unknown): void {
    const now = this.now();
    const last = this.lastWarnAt.get(transportId);
    // `undefined` (never warned for this transport before) always passes — a bare `?? 0` default
    // would silently swallow the very first warning whenever the caller's injected clock (tests,
    // or a process that started at epoch 0) reads `now` as 0 too.
    if (last !== undefined && now - last < WARN_THROTTLE_MS) return;
    this.lastWarnAt.set(transportId, now);
    this.warn(transportId, error);
  }
}

function isPromiseLike(value: unknown): value is Promise<void> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultWarn(transportId: string, error: unknown): void {
  console.warn(`[notifications] transport "${transportId}" failed: ${describeError(error)}`);
}
