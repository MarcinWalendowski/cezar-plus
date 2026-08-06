import type { DeliveryResult, HealthResult, Notification, NotificationTransport, TransportCapabilities } from './types.ts';

/**
 * Test doubles for `src/notifications/**` (W2.4, spec "W2.4 acceptance": "`testkit.ts` exports
 * `recordingTransport()` with verdicts ok / retryable / hard-fail / hang plus a fake clock").
 * Plays the same role this repo's `*.testkit.ts` files play (`server/provider-auth.testkit.ts`,
 * `server/loopback-request.testkit.ts`): a small, deterministic double a sibling package's own
 * test suite imports, rather than each package hand-rolling its own stub `NotificationTransport`.
 * Named `testkit.ts` rather than `notifications.testkit.ts` per the plan's own file list — unlike
 * those two, this one is NOT excluded from the published build (`tsconfig.json`'s
 * `src/**\/*.testkit.ts` exclusion does not match a bare `testkit.ts`), which fits a generic,
 * upstreamable feature: a third party writing their own `NotificationTransport` can import this
 * to test it, the same way they would import anything else this package ships.
 *
 * Every export here is generic — it exercises the {@link NotificationTransport} interface, never
 * the webhook transport's own HTTP mechanics — so it is exactly as upstreamable as the interface
 * itself and names nothing product-specific.
 */

export type RecordingTransportVerdict = 'ok' | 'retryable' | 'hard-fail' | 'hang';

export interface RecordingTransportCall {
  readonly notification: Notification;
  readonly signal: AbortSignal;
}

export interface RecordingTransportOptions {
  id?: string;
  capabilities?: TransportCapabilities;
  /** A fixed verdict for every call, or a function re-evaluated per call (e.g. to model a
   *  transport that fails N times before recovering, the shape the outbox/sender's circuit
   *  breaker needs to exercise). Defaults to `'ok'`. */
  verdict?: RecordingTransportVerdict | (() => RecordingTransportVerdict);
  now?: () => number;
}

export interface RecordingTransport extends NotificationTransport {
  /** Every `send()` call this transport has received, in order — what a caller asserts against
   *  instead of stubbing `fetch`. */
  readonly calls: RecordingTransportCall[];
}

const DEFAULT_CAPABILITIES: TransportCapabilities = {
  maxTitleChars: 200,
  maxBodyChars: 2_000,
  links: 'inline',
  markdown: false,
  batch: true,
  idempotencyKey: false,
};

/**
 * A deterministic {@link NotificationTransport} double: no network, no timers, an outcome the
 * caller controls up front.
 *
 *  - `'ok'` — succeeds immediately.
 *  - `'retryable'` — fails with `retryable: true` (a 5xx / timeout / network-shaped failure).
 *  - `'hard-fail'` — fails with `retryable: false` (a 4xx-shaped failure retrying cannot fix).
 *  - `'hang'` — never settles on its own. Mirrors what a real hung `fetch` does: the returned
 *    promise only resolves once the caller's own `signal` aborts, at which point it REJECTS (the
 *    same shape an aborted `fetch` throws), so a test exercising a caller's timeout wrapper (the
 *    registry's `send()`, the outbox/sender) gets a realistic outcome without an unbounded await.
 */
export function recordingTransport(options: RecordingTransportOptions = {}): RecordingTransport {
  const calls: RecordingTransportCall[] = [];
  const now = options.now ?? Date.now;
  // Captured to a local `const` before narrowing: TS drops a property access's narrowed type
  // once it is read inside a nested closure (the arrow below), reverting `options.verdict` to
  // its full declared union there. A local `const` keeps the narrowing across that boundary.
  const verdictOption = options.verdict;
  const pickVerdict: () => RecordingTransportVerdict =
    typeof verdictOption === 'function' ? verdictOption : () => verdictOption ?? 'ok';

  return {
    id: options.id ?? 'recording',
    kind: 'webhook',
    capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
    calls,

    async send(notification: Notification, signal: AbortSignal): Promise<DeliveryResult> {
      calls.push({ notification, signal });
      const startedAt = now();
      const verdict = pickVerdict();
      switch (verdict) {
        case 'ok':
          return { ok: true, durationMs: now() - startedAt };
        case 'retryable':
          return { ok: false, retryable: true, error: 'recording transport: retryable failure', durationMs: now() - startedAt };
        case 'hard-fail':
          return { ok: false, retryable: false, error: 'recording transport: hard failure', durationMs: now() - startedAt };
        case 'hang':
          return new Promise<DeliveryResult>((_resolve, reject) => {
            if (signal.aborted) {
              reject(describeAbort(signal));
              return;
            }
            signal.addEventListener('abort', () => reject(describeAbort(signal)), { once: true });
          });
      }
    },

    async healthcheck(): Promise<HealthResult> {
      const verdict = pickVerdict();
      return verdict === 'ok' || verdict === 'retryable' ? { ok: true } : { ok: false, error: `recording transport: ${verdict}` };
    },
  };
}

function describeAbort(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error('recording transport: hung past its caller-supplied deadline');
}

// ---- a fake clock, for anything under src/notifications/ that needs an injected `now` ---------

export interface FakeClock {
  now(): number;
  /** Moves the clock forward by `ms` (or backward, for a negative value) and returns the new time. */
  advance(ms: number): number;
  /** Jumps the clock to an absolute ms-epoch value and returns it. */
  set(ms: number): number;
}

/** A minimal, dependency-free controllable clock — no fake timers, no `vi.useFakeTimers()`, just
 *  the `now: () => number` shape every pure function under `src/notifications/` already takes
 *  (`decide()`, `applyRateLimit()`, `isQuietHours()`, and this package's own `createWebhookTransport`
 *  via `WebhookTransportOptions.now`). */
export function createFakeClock(initial = 0): FakeClock {
  let current = initial;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
      return current;
    },
    set(ms: number) {
      current = ms;
      return current;
    },
  };
}
