import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NotificationOutbox,
  notificationsDataDir,
} from "../notifications/outbox.ts";
import { NotificationRegistry } from "../notifications/registry.ts";
import { NotificationSender } from "../notifications/sender.ts";
import type { Notification } from "../notifications/types.ts";
import { apiRequest } from "./loopback-request.testkit.ts";
import {
  createNotificationsRoutes,
  type NotificationsRouteDeps,
} from "./notifications-routes.ts";
import type { NotificationRuntime } from "./project-context.ts";

/**
 * W4.7 targeted suite for the NOTIFICATIONS family. Mounts `createNotificationsRoutes(deps)`
 * directly into a bare app rather than going through `createApp()`/`server.ts` (the real mount
 * point is a scaffold-owned edit this package cannot make yet - see the top-of-file note in
 * `notifications-routes.ts`), so every case injects `deps` itself, exactly as `server.ts` will
 * once wired.
 */

// `config.ts`'s `loadNotificationsConfig`/`mergeWriteNotificationsConfig` (W1.8, not owned by
// this package) resolve `CEZ_HOME` from `process.env` directly - they take no injectable `env`
// (see their own doc comment: "the path is resolved ONCE... CEZ_HOME can change mid-flight under
// a test's afterEach"). So, exactly like `automations-api.test.ts`, isolation for the CONFIG file
// itself has to pin the real `process.env.CEZ_HOME`, not merely a `deps.env` object passed into
// the routes - that seam only reaches `isNotifyOn`/`discoverCockpitUrl`/`describeAuth`/the
// outbox/sender/webhook-transport constructors, all of which DO take an injected env.
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cezar-notifications-api-"));
  process.env.CEZ_HOME = home;
  process.env.CEZ_NOTIFY = "1";
});

afterEach(() => {
  delete process.env.CEZ_HOME;
  delete process.env.CEZ_NOTIFY;
  delete process.env.CEZ_REMOTE;
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function buildRuntime(): NotificationRuntime {
  const outbox = NotificationOutbox.open(notificationsDataDir(process.env));
  let registry!: NotificationRegistry;
  const sender = new NotificationSender({
    outbox,
    send: (transportId, notification, timeoutMs) =>
      registry.send(transportId, notification, timeoutMs),
  });
  registry = new NotificationRegistry({ sink: sender });
  return { outbox, registry, sender };
}

function app(over: Partial<NotificationsRouteDeps> = {}) {
  return createNotificationsRoutes({ env: process.env, ...over });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const createInput = {
  id: "relay",
  label: "Relay Push",
  capabilities: {
    maxTitleChars: 200,
    maxBodyChars: 2_000,
    links: "inline",
    markdown: false,
    batch: true,
    idempotencyKey: false,
  },
  webhook: {
    url: "https://example.test/webhook/inbound?token=abc",
    payload: "envelope",
    auth: { scheme: "bearer", envVar: "MY_WEBHOOK_TOKEN" },
  },
};

function post(body: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
function put(body: unknown) {
  return {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("notifications API - CEZ_NOTIFY off", () => {
  beforeEach(() => {
    delete process.env.CEZ_NOTIFY;
  });

  it("GET answers 200 with an empty, schema-valid payload", async () => {
    const res = await apiRequest(app(), "/workspace/notifications");
    expect(res.status).toBe(200);
    const body = await json<{
      configured: boolean;
      transports: unknown[];
      events: unknown[];
    }>(res);
    expect(body.configured).toBe(false);
    expect(body.transports).toEqual([]);
    expect(body.events).toEqual([]);
  });

  it("GET /log answers 200 with no rows", async () => {
    const res = await apiRequest(app(), "/workspace/notifications/log");
    expect(res.status).toBe(200);
    expect(await json<{ rows: unknown[] }>(res)).toEqual({ rows: [] });
  });

  it("every mutator answers 409, never 404", async () => {
    const server = app();
    const putDefaults = await apiRequest(
      server,
      "/workspace/notifications",
      put({ coalesceMs: 1000 }),
    );
    expect(putDefaults.status).toBe(409);
    const create = await apiRequest(
      server,
      "/workspace/notifications/transports",
      post(createInput),
    );
    expect(create.status).toBe(409);
    const update = await apiRequest(
      server,
      "/workspace/notifications/transports/relay",
      put({ label: "x" }),
    );
    expect(update.status).toBe(409);
    const del = await apiRequest(
      server,
      "/workspace/notifications/transports/relay",
      { method: "DELETE" },
    );
    expect(del.status).toBe(409);
    const test = await apiRequest(
      server,
      "/workspace/notifications/transports/relay/test",
      { method: "POST" },
    );
    expect(test.status).toBe(409);
    const retry = await apiRequest(
      server,
      "/workspace/notifications/log/row-1/retry",
      { method: "POST" },
    );
    expect(retry.status).toBe(409);
  });
});

describe("notifications API - flag on, config CRUD", () => {
  it("creates a transport, never echoing the full URL or the credential", async () => {
    const server = app();
    const res = await apiRequest(
      server,
      "/workspace/notifications/transports",
      post(createInput),
    );
    expect(res.status).toBe(201);
    const raw = await res.text();
    // The env var NAME is legitimate provenance (`describeAuth`'s whole point); only a raw
    // secret VALUE or the full URL (with its query string) must never appear on the wire.
    expect(raw).not.toContain("example.test/webhook/inbound");
    expect(raw).not.toContain("token=abc");
    const body = JSON.parse(raw) as { transport: Record<string, unknown> };
    expect(body.transport).toMatchObject({
      id: "relay",
      endpointHost: "example.test",
      endpointPath: "/webhook/inbound",
    });
    expect(body.transport.url).toBeUndefined();
  });

  it("rejects a duplicate id and an id that fails the transport-id shape", async () => {
    const server = app();
    await apiRequest(
      server,
      "/workspace/notifications/transports",
      post(createInput),
    );
    const dup = await apiRequest(
      server,
      "/workspace/notifications/transports",
      post(createInput),
    );
    expect(dup.status).toBe(409);
    const badId = await apiRequest(
      server,
      "/workspace/notifications/transports",
      post({ ...createInput, id: "Not Valid" }),
    );
    expect(badId.status).toBe(400);
  });

  it("rejects a webhook URL carrying userinfo", async () => {
    const server = app();
    const res = await apiRequest(
      server,
      "/workspace/notifications/transports",
      post({
        ...createInput,
        id: "creds",
        webhook: {
          ...createInput.webhook,
          url: "https://user:pass@example.test/hook",
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("GET reflects a created transport and never leaks its credential", async () => {
    const server = app();
    await apiRequest(
      server,
      "/workspace/notifications/transports",
      post(createInput),
    );
    const res = await apiRequest(server, "/workspace/notifications");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("example.test/webhook/inbound");
    const body = await (async () =>
      JSON.parse(raw) as {
        configured: boolean;
        transports: Array<Record<string, unknown>>;
      })();
    expect(body.configured).toBe(true);
    expect(body.transports).toHaveLength(1);
    expect(body.transports[0]).toMatchObject({
      id: "relay",
      endpointHost: "example.test",
    });
  });

  it("three identical GETs are byte-for-byte equal (no clock-derived field)", async () => {
    const server = app();
    await apiRequest(
      server,
      "/workspace/notifications/transports",
      post(createInput),
    );
    const bodies = await Promise.all(
      [0, 1, 2].map(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return (await apiRequest(server, "/workspace/notifications")).text();
      }),
    );
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[1]).toBe(bodies[2]);
  });

  it("PUT omitting auth preserves the stored credential; the unchanged sentinel does the same", async () => {
    const server = app();
    await apiRequest(
      server,
      "/workspace/notifications/transports",
      post(createInput),
    );

    const relabel = await apiRequest(
      server,
      "/workspace/notifications/transports/relay",
      put({ label: "Renamed" }),
    );
    expect(relabel.status).toBe(200);
    expect(
      (
        await json<{ transport: { label: string; auth: { source: string } } }>(
          relabel,
        )
      ).transport,
    ).toMatchObject({
      label: "Renamed",
      auth: { source: "env", envVar: "MY_WEBHOOK_TOKEN" },
    });

    const explicit = await apiRequest(
      server,
      "/workspace/notifications/transports/relay",
      put({ webhook: { auth: { scheme: "bearer", inline: "__unchanged__" } } }),
    );
    expect(explicit.status).toBe(200);
    expect(
      (await json<{ transport: { auth: { source: string } } }>(explicit))
        .transport.auth,
    ).toMatchObject({ source: "env" });
  });

  it("PUT on an unknown id answers 404", async () => {
    const res = await apiRequest(
      app(),
      "/workspace/notifications/transports/ghost",
      put({ label: "x" }),
    );
    expect(res.status).toBe(404);
  });

  it("DELETE is idempotent", async () => {
    const server = app();
    await apiRequest(
      server,
      "/workspace/notifications/transports",
      post(createInput),
    );
    const first = await apiRequest(
      server,
      "/workspace/notifications/transports/relay",
      { method: "DELETE" },
    );
    expect(first.status).toBe(200);
    expect(await json(first)).toEqual({ deleted: true });
    const second = await apiRequest(
      server,
      "/workspace/notifications/transports/relay",
      { method: "DELETE" },
    );
    expect(second.status).toBe(200);
    expect(await json(second)).toEqual({ deleted: true });
  });

  it("PUT /workspace/notifications merges defaults without touching transports", async () => {
    const server = app();
    const res = await apiRequest(
      server,
      "/workspace/notifications",
      put({ coalesceMs: 12_345, quietHoursAllowUrgent: false }),
    );
    expect(res.status).toBe(200);
    const body = await json<{
      defaults: { coalesceMs: number; quietHoursAllowUrgent: boolean };
    }>(res);
    expect(body.defaults.coalesceMs).toBe(12_345);
    expect(body.defaults.quietHoursAllowUrgent).toBe(false);
  });

  it("stays editable under CEZ_REMOTE=1 (no localHandoff-style gate)", async () => {
    process.env.CEZ_REMOTE = "1";
    const res = await apiRequest(
      app(),
      "/workspace/notifications/transports",
      post(createInput),
    );
    expect(res.status).toBe(201);
  });
});

describe("notifications API - POST .../test", () => {
  it("sends through a throwaway transport and reports delivery, without ever needing deps.notifications", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response("ok", { status: 200 });
      }),
    );
    const server = app(); // deps.notifications intentionally left unset
    await apiRequest(
      server,
      "/workspace/notifications/transports",
      post(createInput),
    );
    const res = await apiRequest(
      server,
      "/workspace/notifications/transports/relay/test",
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = await json<{
      delivered: boolean;
      httpStatus?: number;
      durationMs: number;
    }>(res);
    expect(body).toMatchObject({ delivered: true, httpStatus: 200 });
    expect(typeof body.durationMs).toBe("number");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("example.test/webhook/inbound");
  });

  it("reports a failure without leaking an inline secret", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("nope: super-secret-value", { status: 500 }),
      ),
    );
    const server = app();
    await apiRequest(
      server,
      "/workspace/notifications/transports",
      post({
        ...createInput,
        id: "inline-auth",
        webhook: {
          ...createInput.webhook,
          auth: { scheme: "bearer", inline: "super-secret-value" },
        },
      }),
    );
    const res = await apiRequest(
      server,
      "/workspace/notifications/transports/inline-auth/test",
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("super-secret-value");
    const body = JSON.parse(raw) as {
      delivered: boolean;
      httpStatus?: number;
      error?: string;
    };
    expect(body.delivered).toBe(false);
    expect(body.httpStatus).toBe(500);
  });

  it("answers 404 for an unknown transport id", async () => {
    const res = await apiRequest(
      app(),
      "/workspace/notifications/transports/ghost/test",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });
});

describe("notifications API - log and retry, runtime-dependent", () => {
  it("GET /log and POST retry degrade to safe answers with no runtime wired", async () => {
    const server = app(); // deps.notifications unset even though CEZ_NOTIFY=1
    const log = await apiRequest(server, "/workspace/notifications/log");
    expect(log.status).toBe(200);
    expect(await json(log)).toEqual({ rows: [] });
    const retry = await apiRequest(
      server,
      "/workspace/notifications/log/row-1/retry",
      { method: "POST" },
    );
    expect(retry.status).toBe(409);
  });

  it("GET /log lists outbox rows once the runtime is wired", async () => {
    const runtime = buildRuntime();
    try {
      const notification: Notification = {
        event: "run.failed",
        severity: "urgent",
        projectId: "demo",
        runIds: ["run-1"],
        title: "Run failed",
        body: "It broke.",
        dedupeKey: "demo:run-1:run.failed",
        createdAt: new Date().toISOString(),
      };
      runtime.outbox.reserve("relay", notification);
      const server = app({ notifications: () => runtime });
      const res = await apiRequest(server, "/workspace/notifications/log");
      expect(res.status).toBe(200);
      const body = await json<{
        rows: Array<{ transportId: string; event: string }>;
      }>(res);
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0]).toMatchObject({
        transportId: "relay",
        event: "run.failed",
      });
    } finally {
      runtime.sender.stop();
    }
  });

  it("retry requeues a failed row once the runtime is wired, and reports false otherwise", async () => {
    const runtime = buildRuntime();
    try {
      const notification: Notification = {
        event: "run.failed",
        severity: "urgent",
        projectId: "demo",
        runIds: ["run-1"],
        title: "Run failed",
        body: "It broke.",
        dedupeKey: "demo:run-1:run.failed",
        createdAt: new Date().toISOString(),
      };
      const reserved = runtime.outbox.reserve("relay", notification)!;
      runtime.outbox.markFailed(reserved.rowId, {
        attempts: 1,
        lastError: "boom",
      });
      const server = app({ notifications: () => runtime });

      const retried = await apiRequest(
        server,
        `/workspace/notifications/log/${reserved.rowId}/retry`,
        { method: "POST" },
      );
      expect(retried.status).toBe(200);
      expect(await json(retried)).toEqual({ requeued: true });

      const again = await apiRequest(
        server,
        `/workspace/notifications/log/${reserved.rowId}/retry`,
        { method: "POST" },
      );
      expect(again.status).toBe(200);
      expect(await json(again)).toEqual({ requeued: false });

      const missing = await apiRequest(
        server,
        "/workspace/notifications/log/does-not-exist/retry",
        { method: "POST" },
      );
      expect(missing.status).toBe(200);
      expect(await json(missing)).toEqual({ requeued: false });
    } finally {
      runtime.sender.stop();
    }
  });

  it("registers a persisted transport into the live registry at boot, best-effort", async () => {
    const seedServer = app();
    await apiRequest(
      seedServer,
      "/workspace/notifications/transports",
      post(createInput),
    );

    const runtime = buildRuntime();
    try {
      // Hydration is fire-and-forget (`void hydrateRegistry(...)`); give its microtasks a turn.
      createNotificationsRoutes({
        env: process.env,
        notifications: () => runtime,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runtime.registry.get("relay")).toBeDefined();
    } finally {
      runtime.sender.stop();
    }
  });
});
