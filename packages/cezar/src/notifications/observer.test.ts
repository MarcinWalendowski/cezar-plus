import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStatusSchema } from "@loki-labs/better-cezar-contract";
import { RunStore } from "../runs/store.ts";
import {
  RunNotificationObserver,
  watchRunNotifications,
  type RunNotificationProject,
} from "./observer.ts";
import type {
  DeliveryResult,
  HealthResult,
  Notification,
  NotificationEvent,
  RegisteredTransport,
} from "./types.ts";
import { localCliAuthor } from '../runs/task-author.ts';

/**
 * `observer.test.ts` is scanned by `decider.test.ts`'s own source-level guard ("the one mapping
 * table lives here") exactly like `observer.ts` is — see that file's module doc comment. So this
 * file never writes a bare `RunStatus` string literal either: every status value below comes off
 * `runStatusSchema.enum.<name>` (property access, not a quoted literal), the same zod schema
 * `decider.test.ts` itself pulls its own foreign-vocabulary subtraction from.
 */
const WAITING = runStatusSchema.enum.waiting;
const RUNNING = runStatusSchema.enum.running;
const REVIEW = runStatusSchema.enum.review;
const DONE = runStatusSchema.enum.done;
const FAILED = runStatusSchema.enum.failed;

function fakeRegisteredTransport(id = "acme"): RegisteredTransport {
  return {
    transport: {
      id,
      kind: "webhook",
      capabilities: {
        maxTitleChars: 80,
        maxBodyChars: 1200,
        links: "inline",
        markdown: false,
        batch: true,
        idempotencyKey: true,
      },
      send: vi.fn(async (): Promise<DeliveryResult> => ({
        ok: true,
        durationMs: 1,
      })),
      healthcheck: vi.fn(async (): Promise<HealthResult> => ({ ok: true })),
    },
    route: {
      transportId: id,
      enabled: true,
      events: {},
      projects: null,
      quietHours: null,
      quietHoursAllowUrgent: true,
      rate: null,
      coalesceMs: 20_000,
      urgentCoalesceMs: 5_000,
    },
  };
}

/** Records every `dispatch()` call. `routeFor` always admits the one fake transport unless
 *  `admit: false`, so a test can prove "nothing routed" without needing a real registry. */
function recordingSink(opts: { admit?: boolean } = {}) {
  const admit = opts.admit ?? true;
  const transports = admit ? [fakeRegisteredTransport()] : [];
  const dispatched: Array<{
    notification: Notification;
    transports: readonly RegisteredTransport[];
  }> = [];
  return {
    dispatched,
    routeFor: vi.fn(
      (_event: NotificationEvent, _projectId: string) => transports,
    ),
    dispatch: vi.fn(
      (notification: Notification, ts: readonly RegisteredTransport[]) => {
        dispatched.push({ notification, transports: ts });
      },
    ),
  };
}

function throwingSink(): { routeFor: () => never; dispatch: () => never } {
  return {
    routeFor: () => {
      throw new Error("routeFor exploded");
    },
    dispatch: () => {
      throw new Error("dispatch exploded");
    },
  };
}

/** `decide()`'s own default boot-grace window is 10s (`decider.ts`'s `DEFAULT_BOOT_GRACE_MS`, not
 *  exported — this file never names it, only outlasts it). Every test below that expects a REAL
 *  transition to dispatch needs its injected clock to have moved at least this far past `bootAt`
 *  (the instant `watchRunNotifications`/`observer.watch` captured `now()`) before that transition,
 *  or the transition is correctly, silently recorded-not-sent by the boot-grace rule itself — see
 *  the dedicated boot-grace test below for that rule's own coverage. */
const PAST_BOOT_GRACE_MS = 20_000;

/** A controllable clock: `now` starts at an arbitrary base and only moves when `advance()` is
 *  called, so a test can place a transition precisely inside or outside the boot-grace window. */
function makeClock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe("notifications/observer: watchRunNotifications", () => {
  let root: string;
  let store: RunStore;
  const unwatchers: Array<() => void> = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cez-notify-observer-"));
    store = RunStore.open(join(root, ".ai/cezar"));
  });

  afterEach(() => {
    for (const unwatch of unwatchers.splice(0)) unwatch();
    store.flush();
    store.removeAllListeners();
    rmSync(root, { recursive: true, force: true });
  });

  /** Attaches with a controlled clock already moved past the default boot grace, so every
   *  transition a test drives afterward is evaluated as "normal operation," not "just booted." */
  const watch = (
    project: RunNotificationProject = { id: "proj-1", name: "My Project" },
    opts: { admit?: boolean } = {},
  ) => {
    const clock = makeClock();
    const sink = recordingSink(opts);
    unwatchers.push(
      watchRunNotifications(store, sink, project, { now: clock.now }),
    );
    clock.advance(PAST_BOOT_GRACE_MS);
    return sink;
  };

  it("first sight is silent: attaching to a store that already moved a run notifies nothing on that run's next touch", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "pre-existing",
      workflow: "w",
      task: "t",
      steps: [],
    });
    store.updateRun(run.id, { status: REVIEW });
    // Observation starts AFTER the run already reached `review` — its own previous-status map is
    // empty, so the very next touch (moving to `done`) is this listener's first sight of the run,
    // which must record the baseline silently rather than notify.
    const sink = watch();
    store.updateRun(run.id, { status: DONE });
    expect(sink.dispatched).toHaveLength(0);
  });

  it("a real transition after first sight notifies (run.finished on -> done)", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "finishing",
      workflow: "w",
      task: "t",
      steps: [],
    });
    const sink = watch();
    store.updateRun(run.id, { status: RUNNING }); // first sight, silent
    store.updateRun(run.id, { status: DONE }); // real transition
    expect(sink.dispatched).toHaveLength(1);
    expect(sink.dispatched[0]?.notification.event).toBe("run.finished");
    expect(sink.dispatched[0]?.notification.runIds).toEqual([run.id]);
  });

  it("an unchanged status re-touch (e.g. a title edit) notifies nothing", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "stable",
      workflow: "w",
      task: "t",
      steps: [],
    });
    const sink = watch();
    store.updateRun(run.id, { status: RUNNING }); // first sight
    store.updateRun(run.id, { status: RUNNING, title: "renamed" }); // touch, no status change
    expect(sink.dispatched).toHaveLength(0);
  });

  it("run.failed fires on -> failed with no autoResumeAt", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "oops",
      workflow: "w",
      task: "t",
      steps: [],
    });
    const sink = watch();
    store.updateRun(run.id, { status: RUNNING });
    store.updateRun(run.id, { status: FAILED });
    expect(sink.dispatched).toHaveLength(1);
    expect(sink.dispatched[0]?.notification.event).toBe("run.failed");
  });

  it("run.usage-limit fires (never run.failed) on -> failed WITH autoResumeAt", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "limited",
      workflow: "w",
      task: "t",
      steps: [],
    });
    const sink = watch();
    store.updateRun(run.id, { status: RUNNING });
    store.updateRun(run.id, {
      status: FAILED,
      autoResumeAt: "2026-08-07T00:00:00.000Z",
    });
    expect(sink.dispatched).toHaveLength(1);
    expect(sink.dispatched[0]?.notification.event).toBe("run.usage-limit");
    expect(sink.dispatched[0]?.notification.body).toContain(
      "2026-08-07T00:00:00.000Z",
    );
  });

  it("run.review fires on -> review and carries the pull request URL", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "ready",
      workflow: "w",
      task: "t",
      steps: [],
    });
    const sink = watch();
    store.updateRun(run.id, { status: RUNNING });
    store.updateRun(run.id, {
      status: REVIEW,
      pullRequestUrl: "https://github.com/x/y/pull/1",
    });
    expect(sink.dispatched).toHaveLength(1);
    expect(sink.dispatched[0]?.notification.event).toBe("run.review");
    expect(sink.dispatched[0]?.notification.url).toBe(
      "https://github.com/x/y/pull/1",
    );
  });

  it("run.needs-you carries the first question of the LAST ask.requested event, within a bounded tail scan", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "blocked",
      workflow: "w",
      task: "t",
      steps: [],
    });
    const sink = watch();
    store.updateRun(run.id, { status: RUNNING }); // first sight

    store.appendEvent(run.id, {
      type: "ask.requested",
      requestId: "r1",
      questions: [
        {
          header: "stale",
          question: "An earlier, superseded question?",
          options: [],
        },
      ],
    });
    // Unrelated events between the two asks — proves this reads the LAST one, not the first.
    for (let i = 0; i < 5; i += 1) {
      store.appendEvent(run.id, { type: "note", message: `noise ${i}` });
    }
    store.appendEvent(run.id, {
      type: "ask.requested",
      requestId: "r2",
      questions: [
        {
          header: "current",
          question: "Which database should this use?",
          options: [],
        },
        {
          header: "second",
          question: "A second question, not the first.",
          options: [],
        },
      ],
    });

    store.updateRun(run.id, { status: WAITING });

    expect(sink.dispatched).toHaveLength(1);
    expect(sink.dispatched[0]?.notification.event).toBe("run.needs-you");
    expect(sink.dispatched[0]?.notification.body).toBe(
      "Which database should this use?",
    );
  });

  it("run.needs-you falls back to the decider default body when no ask.requested event exists", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "blocked, no ask",
      workflow: "w",
      task: "t",
      steps: [],
    });
    const sink = watch();
    store.updateRun(run.id, { status: RUNNING });
    store.updateRun(run.id, { status: WAITING });
    expect(sink.dispatched).toHaveLength(1);
    expect(sink.dispatched[0]?.notification.body).toBe("Waiting on you.");
  });

  it("never reads the run event log for a transition that does not need the ASK text", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "no read needed",
      workflow: "w",
      task: "t",
      steps: [],
    });
    const readSpy = vi.spyOn(store, "readEvents");
    const sink = watch();
    store.updateRun(run.id, { status: RUNNING }); // first sight
    store.updateRun(run.id, { status: DONE }); // run.finished, no ASK text needed
    expect(sink.dispatched).toHaveLength(1);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("reads the run event log exactly once for a transition that DOES need the ASK text", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "needs a read",
      workflow: "w",
      task: "t",
      steps: [],
    });
    const readSpy = vi.spyOn(store, "readEvents");
    const sink = watch();
    store.updateRun(run.id, { status: RUNNING });
    store.updateRun(run.id, { status: WAITING });
    expect(sink.dispatched).toHaveLength(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it("each notification carries its owning project id and name", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "attributed",
      workflow: "w",
      task: "t",
      steps: [],
    });
    const sink = watch({ id: "proj-42", name: "The Forty-Second Project" });
    store.updateRun(run.id, { status: RUNNING });
    store.updateRun(run.id, { status: DONE });
    expect(sink.dispatched[0]?.notification.projectId).toBe("proj-42");
    expect(sink.dispatched[0]?.notification.projectName).toBe(
      "The Forty-Second Project",
    );
  });

  it("routes nothing when the sink admits no transports, without throwing", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "nobody listening",
      workflow: "w",
      task: "t",
      steps: [],
    });
    const sink = watch({ id: "proj-1" }, { admit: false });
    store.updateRun(run.id, { status: RUNNING });
    expect(() => store.updateRun(run.id, { status: DONE })).not.toThrow();
    expect(sink.dispatch).not.toHaveBeenCalled();
  });

  it("subscribes to (event, ...) only for provider-auth-required, ignoring every other event type", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "auth",
      workflow: "w",
      task: "t",
      steps: [],
    });
    const sink = watch();
    store.appendEvent(run.id, { type: "error", message: "unrelated" });
    store.appendEvent(run.id, { type: "note", message: "also unrelated" });
    expect(sink.dispatched).toHaveLength(0);

    store.appendEvent(run.id, {
      type: "provider-auth-required",
      provider: "codex",
      authFailureId: "incident-1",
    });
    expect(sink.dispatched).toHaveLength(1);
    expect(sink.dispatched[0]?.notification.event).toBe(
      "provider.auth-required",
    );
  });

  it("provider-auth-required carries the project id/name and ignores a malformed event silently", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "auth2",
      workflow: "w",
      task: "t",
      steps: [],
    });
    const sink = watch({ id: "proj-9", name: "Nine" });

    // Missing authFailureId — must be ignored, not throw and not dispatch.
    store.appendEvent(run.id, {
      type: "provider-auth-required",
      provider: "claude",
    });
    expect(sink.dispatched).toHaveLength(0);

    store.appendEvent(run.id, {
      type: "provider-auth-required",
      provider: "claude",
      authFailureId: "incident-9",
    });
    expect(sink.dispatched).toHaveLength(1);
    expect(sink.dispatched[0]?.notification.projectId).toBe("proj-9");
    expect(sink.dispatched[0]?.notification.projectName).toBe("Nine");
  });

  it("returns an unsubscribe that stops all future delivery", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "unsub",
      workflow: "w",
      task: "t",
      steps: [],
    });
    const sink = recordingSink();
    const clock = makeClock();
    const unwatch = watchRunNotifications(
      store,
      sink,
      { id: "proj-1" },
      { now: clock.now },
    );
    clock.advance(PAST_BOOT_GRACE_MS);
    store.updateRun(run.id, { status: RUNNING });
    store.updateRun(run.id, { status: DONE });
    expect(sink.dispatched).toHaveLength(1);

    unwatch();
    store.updateRun(run.id, { status: RUNNING });
    store.updateRun(run.id, { status: FAILED });
    expect(sink.dispatched).toHaveLength(1);
  });

  it("a boot-grace window records transitions without sending, then sends normally once it closes", () => {
    let now = 1_000_000;
    const sink = recordingSink();
    const run = store.createRun({ author: localCliAuthor(),
      title: "boot",
      workflow: "w",
      task: "t",
      steps: [],
    });
    unwatchers.push(
      watchRunNotifications(store, sink, { id: "proj-1" }, { now: () => now }),
    );

    store.updateRun(run.id, { status: RUNNING }); // first sight at bootAt
    now += 2_000; // still inside the default 10s boot grace
    store.updateRun(run.id, { status: DONE });
    expect(sink.dispatched).toHaveLength(0);

    now += 20_000; // well past the boot grace
    // A no-op re-touch keeps `previousStatuses` accurate without minting a second transition.
    store.updateRun(run.id, { status: RUNNING });
    store.updateRun(run.id, { status: DONE });
    expect(sink.dispatched).toHaveLength(1);
  });
});

describe("notifications/observer: a failing sink can never touch a run", () => {
  let root: string;
  let store: RunStore;
  const unwatchers: Array<() => void> = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cez-notify-observer-fail-"));
    store = RunStore.open(join(root, ".ai/cezar"));
  });

  afterEach(() => {
    for (const unwatch of unwatchers.splice(0)) unwatch();
    store.flush();
    store.removeAllListeners();
    rmSync(root, { recursive: true, force: true });
  });

  it("a synchronously-throwing sink leaves the run byte-identical to one with no notifier attached", () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: "fragile",
      workflow: "w",
      task: "t",
      steps: [],
    });
    // `createRun` alone writes no per-run NDJSON line (only `appendEvent` does) — append one
    // harmless event first so "before" and "after" compare an existing file, not a missing one.
    store.appendEvent(run.id, { type: "note", message: "baseline" });
    const eventsPath = join(root, ".ai/cezar/runs", `${run.id}.ndjson`);
    const eventsBefore = readFileSync(eventsPath, "utf8");

    const clock = makeClock();
    unwatchers.push(
      watchRunNotifications(
        store,
        throwingSink(),
        { id: "proj-1" },
        { now: clock.now },
      ),
    );
    clock.advance(PAST_BOOT_GRACE_MS);

    expect(() => store.updateRun(run.id, { status: RUNNING })).not.toThrow();
    expect(() => store.updateRun(run.id, { status: DONE })).not.toThrow();

    const eventsAfter = readFileSync(eventsPath, "utf8");
    expect(eventsAfter).toBe(eventsBefore);
    expect(store.getRun(run.id)?.status).toBe(DONE);
  });

  it("warns at most once per hour, even across repeated failures", () => {
    const clock = makeClock();
    const warn = vi.fn();
    const run = store.createRun({ author: localCliAuthor(),
      title: "noisy failure",
      workflow: "w",
      task: "t",
      steps: [],
    });
    unwatchers.push(
      watchRunNotifications(
        store,
        throwingSink(),
        { id: "proj-1" },
        { now: clock.now, warn },
      ),
    );
    clock.advance(PAST_BOOT_GRACE_MS);

    store.updateRun(run.id, { status: RUNNING }); // first sight, no dispatch attempted, no warn
    clock.advance(1_000);
    store.updateRun(run.id, { status: DONE }); // dispatch attempted, sink throws -> 1st warn
    clock.advance(1_000);
    store.updateRun(run.id, { status: RUNNING });
    clock.advance(1_000);
    store.updateRun(run.id, { status: FAILED }); // another failure inside the same hour -> throttled
    expect(warn).toHaveBeenCalledTimes(1);

    clock.advance(61 * 60_000); // past the one-hour throttle window
    store.updateRun(run.id, { status: RUNNING });
    clock.advance(1_000);
    store.updateRun(run.id, { status: DONE });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("notifications/observer: RunNotificationObserver (WeakSet dedupe)", () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cez-notify-observer-dedupe-"));
    store = RunStore.open(join(root, ".ai/cezar"));
  });

  afterEach(() => {
    store.flush();
    store.removeAllListeners();
    rmSync(root, { recursive: true, force: true });
  });

  it("watching the same store twice yields exactly one listener", () => {
    const sink = recordingSink();
    const clock = makeClock();
    const observer = new RunNotificationObserver(sink, { now: clock.now });
    const run = store.createRun({ author: localCliAuthor(),
      title: "deduped",
      workflow: "w",
      task: "t",
      steps: [],
    });

    observer.watch(store, { id: "proj-1" });
    observer.watch(store, { id: "proj-1" });
    clock.advance(PAST_BOOT_GRACE_MS);

    store.updateRun(run.id, { status: RUNNING });
    store.updateRun(run.id, { status: DONE });

    expect(sink.dispatched).toHaveLength(1);
  });

  it("watching two different stores yields one listener each", () => {
    const otherRoot = mkdtempSync(
      join(tmpdir(), "cez-notify-observer-dedupe-2-"),
    );
    const otherStore = RunStore.open(join(otherRoot, ".ai/cezar"));
    try {
      const sink = recordingSink();
      const clock = makeClock();
      const observer = new RunNotificationObserver(sink, { now: clock.now });
      const runA = store.createRun({ author: localCliAuthor(),
        title: "a",
        workflow: "w",
        task: "t",
        steps: [],
      });
      const runB = otherStore.createRun({ author: localCliAuthor(),
        title: "b",
        workflow: "w",
        task: "t",
        steps: [],
      });

      observer.watch(store, { id: "proj-a" });
      observer.watch(otherStore, { id: "proj-b" });
      clock.advance(PAST_BOOT_GRACE_MS);

      store.updateRun(runA.id, { status: RUNNING });
      store.updateRun(runA.id, { status: DONE });
      otherStore.updateRun(runB.id, { status: RUNNING });
      otherStore.updateRun(runB.id, { status: DONE });

      expect(sink.dispatched).toHaveLength(2);
      expect(
        sink.dispatched.map((d) => d.notification.projectId).sort(),
      ).toEqual(["proj-a", "proj-b"]);
    } finally {
      otherStore.flush();
      otherStore.removeAllListeners();
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

describe("notifications/observer: no await of a notification path in the run/store critical path", () => {
  it("workflows/run.ts imports nothing from notifications/", () => {
    const source = readFileSync(
      new URL("../workflows/run.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+['"](\.\.\/)*notifications\//);
  });

  it("runs/store.ts imports nothing from notifications/", () => {
    const source = readFileSync(
      new URL("../runs/store.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+['"](\.\.\/)*notifications\//);
  });
});
