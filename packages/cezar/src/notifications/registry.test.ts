import { describe, expect, it, vi } from 'vitest';
import { NotificationRegistry } from './registry.ts';
import type {
  DeliveryResult,
  HealthResult,
  Notification,
  NotificationSink,
  NotificationTransport,
  RegisteredTransport,
  TransportRoute,
} from './types.ts';

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    event: 'run.finished',
    severity: 'info',
    projectId: 'proj-1',
    runIds: ['run-1'],
    title: 'Fix the thing',
    body: 'Finished.',
    dedupeKey: 'proj-1:run-1:run.finished',
    createdAt: '2026-08-06T12:00:00.000Z',
    ...overrides,
  };
}

function route(overrides: Partial<TransportRoute> = {}): TransportRoute {
  return {
    transportId: 'acme',
    enabled: true,
    events: {},
    projects: null,
    quietHours: null,
    quietHoursAllowUrgent: true,
    rate: null,
    coalesceMs: 20_000,
    urgentCoalesceMs: 5_000,
    ...overrides,
  };
}

function fakeTransport(overrides: Partial<NotificationTransport> = {}): NotificationTransport {
  return {
    id: 'acme',
    kind: 'webhook',
    capabilities: {
      maxTitleChars: 80,
      maxBodyChars: 1200,
      links: 'inline',
      markdown: false,
      batch: true,
      idempotencyKey: true,
    },
    send: vi.fn(async (): Promise<DeliveryResult> => ({ ok: true, durationMs: 1 })),
    healthcheck: vi.fn(async (): Promise<HealthResult> => ({ ok: true })),
    ...overrides,
  };
}

function entry(transport: NotificationTransport, r: TransportRoute = route()): RegisteredTransport {
  return { transport, route: r };
}

describe('notifications/registry: bookkeeping', () => {
  it('registers, lists, gets and unregisters instances (never types) by transportId', () => {
    const registry = new NotificationRegistry({ sink: { reserve: () => {} } });
    const transport = fakeTransport();
    registry.register(entry(transport));
    expect(registry.get('acme')?.transport).toBe(transport);
    expect(registry.list()).toHaveLength(1);

    registry.unregister('acme');
    expect(registry.get('acme')).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });

  it('rejects registering a transport whose own id does not match its route.transportId', () => {
    const registry = new NotificationRegistry({ sink: { reserve: () => {} } });
    expect(() => registry.register(entry(fakeTransport({ id: 'acme' }), route({ transportId: 'other' })))).toThrow(
      /transport id mismatch/,
    );
  });

  it('registering the same transportId twice replaces rather than accumulates', () => {
    const registry = new NotificationRegistry({ sink: { reserve: () => {} } });
    registry.register(entry(fakeTransport()));
    registry.register(entry(fakeTransport(), route({ enabled: false })));
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('acme')?.route.enabled).toBe(false);
  });
});

describe('notifications/registry: routeFor', () => {
  it('admits an enabled transport with no explicit event override (falls back to EVENT_CATALOG default)', () => {
    const registry = new NotificationRegistry({ sink: { reserve: () => {} } });
    registry.register(entry(fakeTransport()));
    expect(registry.routeFor('run.failed', 'proj-1')).toHaveLength(1);
  });

  it('excludes a disabled transport', () => {
    const registry = new NotificationRegistry({ sink: { reserve: () => {} } });
    registry.register(entry(fakeTransport(), route({ enabled: false })));
    expect(registry.routeFor('run.failed', 'proj-1')).toHaveLength(0);
  });

  it('an explicit false in the events matrix overrides the catalog default of true', () => {
    const registry = new NotificationRegistry({ sink: { reserve: () => {} } });
    registry.register(entry(fakeTransport(), route({ events: { 'run.failed': false } })));
    expect(registry.routeFor('run.failed', 'proj-1')).toHaveLength(0);
  });

  it('an explicit true in the events matrix overrides the catalog default of false (queue.drained)', () => {
    const registry = new NotificationRegistry({ sink: { reserve: () => {} } });
    registry.register(entry(fakeTransport(), route({ events: { 'queue.drained': true } })));
    expect(registry.routeFor('queue.drained', 'proj-1')).toHaveLength(1);
  });

  it('queue.drained is excluded by default (EVENT_CATALOG default is false)', () => {
    const registry = new NotificationRegistry({ sink: { reserve: () => {} } });
    registry.register(entry(fakeTransport()));
    expect(registry.routeFor('queue.drained', 'proj-1')).toHaveLength(0);
  });

  it('projects: null admits every project; a named list restricts to its members', () => {
    const registry = new NotificationRegistry({ sink: { reserve: () => {} } });
    registry.register(entry(fakeTransport(), route({ projects: ['proj-a'] })));
    expect(registry.routeFor('run.failed', 'proj-a')).toHaveLength(1);
    expect(registry.routeFor('run.failed', 'proj-b')).toHaveLength(0);
  });
});

describe('notifications/registry: dispatch() never awaits and never throws', () => {
  it('a synchronously-throwing sink does not escape dispatch()', () => {
    const sink: NotificationSink = {
      reserve: () => {
        throw new Error('disk full');
      },
    };
    const registry = new NotificationRegistry({ sink, warn: vi.fn() });
    registry.register(entry(fakeTransport()));
    expect(() => registry.dispatch(notification(), registry.routeFor('run.finished', 'proj-1'))).not.toThrow();
  });

  it('a sink returning a rejected promise does not produce an unhandled rejection, and dispatch() returns synchronously', async () => {
    let resolveReserve: (() => void) | undefined;
    const sink: NotificationSink = {
      reserve: () =>
        new Promise<void>((_resolve, reject) => {
          resolveReserve = () => reject(new Error('write failed'));
        }),
    };
    const warn = vi.fn();
    const registry = new NotificationRegistry({ sink, warn });
    registry.register(entry(fakeTransport()));

    const before = Date.now();
    registry.dispatch(notification(), registry.routeFor('run.finished', 'proj-1'));
    // dispatch() must have returned already — the promise above hasn't even settled yet.
    expect(Date.now() - before).toBeLessThan(50);
    expect(warn).not.toHaveBeenCalled();

    resolveReserve?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe('acme');
  });

  it('calls reserve() once per admitted transport, and never for one the notification was not routed to', () => {
    const reserve = vi.fn();
    const registry = new NotificationRegistry({ sink: { reserve } });
    registry.register(entry(fakeTransport({ id: 'a' }), route({ transportId: 'a' })));
    registry.register(entry(fakeTransport({ id: 'b' }), route({ transportId: 'b', enabled: false })));
    registry.dispatch(notification(), registry.routeFor('run.finished', 'proj-1'));
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls[0]?.[0]).toBe('a');
  });

  it('throttles the failure warning to once per transport per hour', () => {
    let now = 0;
    const sink: NotificationSink = {
      reserve: () => {
        throw new Error('boom');
      },
    };
    const warn = vi.fn();
    const registry = new NotificationRegistry({ sink, warn, now: () => now });
    registry.register(entry(fakeTransport()));
    const transports = registry.routeFor('run.finished', 'proj-1');

    registry.dispatch(notification(), transports);
    now += 1_000;
    registry.dispatch(notification(), transports);
    now += 1_000;
    registry.dispatch(notification(), transports);
    expect(warn).toHaveBeenCalledTimes(1);

    now += 60 * 60 * 1000 + 1;
    registry.dispatch(notification(), transports);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('notifications/registry: send() wraps every transport call', () => {
  it('passes through a successful DeliveryResult', async () => {
    const transport = fakeTransport();
    const registry = new NotificationRegistry({ sink: { reserve: () => {} } });
    registry.register(entry(transport));
    const result = await registry.send('acme', notification());
    expect(result).toEqual({ ok: true, durationMs: 1 });
  });

  it('coerces a synchronous throw into {ok:false, retryable:true}', async () => {
    const transport = fakeTransport({
      send: () => {
        throw new Error('boom');
      },
    });
    const registry = new NotificationRegistry({ sink: { reserve: () => {} } });
    registry.register(entry(transport));
    const result = await registry.send('acme', notification());
    expect(result.ok).toBe(false);
    expect((result as Extract<DeliveryResult, { ok: false }>).retryable).toBe(true);
    expect((result as Extract<DeliveryResult, { ok: false }>).error).toContain('boom');
  });

  it('coerces a rejected promise into {ok:false, retryable:true}', async () => {
    const transport = fakeTransport({ send: async () => Promise.reject(new Error('network down')) });
    const registry = new NotificationRegistry({ sink: { reserve: () => {} } });
    registry.register(entry(transport));
    const result = await registry.send('acme', notification());
    expect(result.ok).toBe(false);
    expect((result as Extract<DeliveryResult, { ok: false }>).error).toContain('network down');
  });

  it('coerces a hang past timeoutMs into {ok:false, retryable:true} once the transport honors the abort signal', async () => {
    const transport = fakeTransport({
      send: (_notification, signal) =>
        new Promise<DeliveryResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const registry = new NotificationRegistry({ sink: { reserve: () => {} } });
    registry.register(entry(transport));
    const result = await registry.send('acme', notification(), 5);
    expect(result.ok).toBe(false);
    expect((result as Extract<DeliveryResult, { ok: false }>).retryable).toBe(true);
  });

  it('an unknown transportId answers {ok:false, retryable:false} rather than throwing', async () => {
    const registry = new NotificationRegistry({ sink: { reserve: () => {} } });
    const result = await registry.send('does-not-exist', notification());
    expect(result).toMatchObject({ ok: false, retryable: false });
  });
});
