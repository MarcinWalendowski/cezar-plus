import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runNotifyCommand, type NotifyCommandIo } from "./cli.ts";
import { loadNotificationsConfig } from "./config.ts";
import { NotificationOutbox, notificationsDataDir } from "./outbox.ts";
import type { Notification } from "./types.ts";

/**
 * W4.7 targeted suite for `cez notify`. Nothing here touches `console` or the network (`io` and
 * `fetchImpl` are injected), but `CEZ_HOME` isolation has to be the real `process.env.CEZ_HOME`,
 * not a local object: `config.ts`'s `loadNotificationsConfig`/`mergeWriteNotificationsConfig`
 * (W1.8, not owned by this package) resolve it from `process.env` directly and take no injectable
 * `env` - see the same note in `server/notifications-api.test.ts`. Mirrors
 * `server/automations-api.test.ts`'s own per-test `process.env.CEZ_HOME` pin.
 */

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cezar-notify-cli-"));
  process.env.CEZ_HOME = home;
});

afterEach(() => {
  delete process.env.CEZ_HOME;
  rmSync(home, { recursive: true, force: true });
});

function captureIo(): NotifyCommandIo & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  };
}

function run(
  args: string[],
  io: NotifyCommandIo,
  extra: { fetchImpl?: typeof fetch; now?: () => number } = {},
) {
  return runNotifyCommand(args, { env: process.env, io, ...extra });
}

describe("cez notify list", () => {
  it("reports no transports configured", async () => {
    const io = captureIo();
    expect(await run(["list"], io)).toBe(0);
    expect(io.logs.join("\n")).toContain(
      "no notification transports configured",
    );
  });

  it("defaults to list with no subcommand", async () => {
    const io = captureIo();
    expect(await run([], io)).toBe(0);
    expect(io.logs.join("\n")).toContain(
      "no notification transports configured",
    );
  });

  it("lists a created transport and flags CEZ_NOTIFY as inactive when unset", async () => {
    const io = captureIo();
    await run(
      [
        "add",
        "relay",
        "--url",
        "https://example.test/hook?token=abc",
        "--auth-env",
        "MY_TOKEN",
      ],
      io,
    );
    const listIo = captureIo();
    expect(await run(["list"], listIo)).toBe(0);
    const out = listIo.logs.join("\n");
    expect(out).toContain("relay");
    expect(out).toContain("https://example.test/hook?token=abc");
    expect(out).toContain("env:MY_TOKEN");
    expect(out).toContain("CEZ_NOTIFY is not set to 1");
  });
});

describe("cez notify add", () => {
  it("creates a webhook transport with the full allow-list default matrix", async () => {
    const io = captureIo();
    const code = await run(
      ["add", "relay", "--url", "https://example.test/hook"],
      io,
    );
    expect(code).toBe(0);
    expect(io.errors).toEqual([]);
    const config = await loadNotificationsConfig();
    expect(config.transports).toHaveLength(1);
    expect(config.transports[0]).toMatchObject({
      id: "relay",
      kind: "webhook",
      enabled: true,
      label: "relay",
    });
    expect(config.transports[0]!.events).toMatchObject({
      "run.failed": true,
      "queue.drained": false,
    });
  });

  it("--events is read as a full allow-list, not additive", async () => {
    const io = captureIo();
    await run(
      [
        "add",
        "relay",
        "--url",
        "https://example.test/hook",
        "--events",
        "run.failed,run.needs-you",
      ],
      io,
    );
    const config = await loadNotificationsConfig();
    expect(config.transports[0]!.events).toEqual({
      "run.failed": true,
      "run.needs-you": true,
      "run.review": false,
      "run.finished": false,
      "run.usage-limit": false,
      "provider.auth-required": false,
      "queue.drained": false,
    });
  });

  it("rejects a missing --url", async () => {
    const io = captureIo();
    expect(await run(["add", "relay"], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("missing --url");
  });

  it("rejects an id that fails the transport-id shape", async () => {
    const io = captureIo();
    expect(
      await run(["add", "Not Valid", "--url", "https://example.test/hook"], io),
    ).toBe(1);
    expect(io.errors.join("\n")).toContain("invalid transport id");
  });

  it("rejects a URL carrying userinfo", async () => {
    const io = captureIo();
    expect(
      await run(
        ["add", "relay", "--url", "https://user:pass@example.test/hook"],
        io,
      ),
    ).toBe(1);
  });

  it("rejects both --auth-env and --auth-inline together", async () => {
    const io = captureIo();
    const code = await run(
      [
        "add",
        "relay",
        "--url",
        "https://example.test/hook",
        "--auth-env",
        "A",
        "--auth-inline",
        "B",
      ],
      io,
    );
    expect(code).toBe(1);
    expect(io.errors.join("\n")).toContain("not both");
  });

  it("rejects --payload template with no --template", async () => {
    const io = captureIo();
    const code = await run(
      [
        "add",
        "relay",
        "--url",
        "https://example.test/hook",
        "--payload",
        "template",
      ],
      io,
    );
    expect(code).toBe(1);
    expect(io.errors.join("\n")).toContain("requires --template");
  });

  it("rejects a duplicate id", async () => {
    const io = captureIo();
    await run(["add", "relay", "--url", "https://example.test/hook"], io);
    const second = captureIo();
    expect(
      await run(["add", "relay", "--url", "https://example.test/other"], second),
    ).toBe(1);
    expect(second.errors.join("\n")).toContain("already exists");
  });
});

describe("cez notify set / enable / disable / rm", () => {
  async function seed() {
    await run(
      [
        "add",
        "relay",
        "--url",
        "https://example.test/hook",
        "--auth-env",
        "MY_TOKEN",
      ],
      captureIo(),
    );
  }

  it("updates only the fields given, preserving everything else including auth", async () => {
    await seed();
    const io = captureIo();
    expect(await run(["set", "relay", "--label", "Renamed"], io)).toBe(0);
    const config = await loadNotificationsConfig();
    expect(config.transports[0]).toMatchObject({ label: "Renamed" });
    expect(config.transports[0]!.webhook.auth).toMatchObject({
      envVar: "MY_TOKEN",
    });
    expect(config.transports[0]!.webhook.url).toBe("https://example.test/hook");
  });

  it("accepts --quiet and --rate shorthand", async () => {
    await seed();
    const io = captureIo();
    expect(
      await run(["set", "relay", "--quiet", "22:00-07:00", "--rate", "5/h"], io),
    ).toBe(0);
    const config = await loadNotificationsConfig();
    expect(config.transports[0]!.quietHours).toEqual({
      start: "22:00",
      end: "07:00",
    });
    expect(config.transports[0]!.rate).toMatchObject({ perHour: 5 });
  });

  it("rejects a malformed --quiet value", async () => {
    await seed();
    const io = captureIo();
    expect(await run(["set", "relay", "--quiet", "not-a-window"], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("invalid --quiet");
  });

  it("errors on an unknown id", async () => {
    const io = captureIo();
    expect(await run(["set", "ghost", "--label", "x"], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("unknown transport");
  });

  it("enable/disable toggle the stored row", async () => {
    await seed();
    const off = captureIo();
    expect(await run(["disable", "relay"], off)).toBe(0);
    expect((await loadNotificationsConfig()).transports[0]!.enabled).toBe(
      false,
    );
    const on = captureIo();
    expect(await run(["enable", "relay"], on)).toBe(0);
    expect((await loadNotificationsConfig()).transports[0]!.enabled).toBe(true);
  });

  it("rm is idempotent", async () => {
    await seed();
    const first = captureIo();
    expect(await run(["rm", "relay"], first)).toBe(0);
    expect((await loadNotificationsConfig()).transports).toHaveLength(0);
    const second = captureIo();
    expect(await run(["rm", "relay"], second)).toBe(0);
    expect(second.logs.join("\n")).toContain("not found");
  });
});

describe("cez notify test", () => {
  it("exits 0 on a delivered send, using the injected fetch (never the real network)", async () => {
    await run(
      ["add", "relay", "--url", "https://example.test/hook"],
      captureIo(),
    );
    let called = false;
    const fetchImpl = (async (input: string | URL) => {
      called = true;
      expect(String(input)).toContain("example.test/hook");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const io = captureIo();
    const code = await run(["test", "relay"], io, { fetchImpl });
    expect(code).toBe(0);
    expect(called).toBe(true);
    expect(io.logs.join("\n")).toContain("delivered");
  });

  it("exits 1 on a failed send", async () => {
    await run(
      ["add", "relay", "--url", "https://example.test/hook"],
      captureIo(),
    );
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;
    const io = captureIo();
    const code = await run(["test", "relay"], io, { fetchImpl });
    expect(code).toBe(1);
    expect(io.errors.join("\n")).toContain("failed");
  });

  it("exits 1 for an unknown transport id", async () => {
    const io = captureIo();
    expect(await run(["test", "ghost"], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("unknown transport");
  });
});

describe("cez notify log", () => {
  it("reports no rows when the outbox is empty", async () => {
    const io = captureIo();
    expect(await run(["log"], io)).toBe(0);
    expect(io.logs.join("\n")).toContain("no notification log rows");
  });

  it("lists rows written directly to the outbox", async () => {
    const outbox = NotificationOutbox.open(notificationsDataDir(process.env));
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
    outbox.reserve("relay", notification);
    const io = captureIo();
    expect(await run(["log"], io)).toBe(0);
    const out = io.logs.join("\n");
    expect(out).toContain("relay");
    expect(out).toContain("run.failed");
  });
});

describe("cez notify unknown subcommand", () => {
  it("prints usage and exits 1", async () => {
    const io = captureIo();
    expect(await run(["bogus"], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("unknown notify subcommand");
  });
});
