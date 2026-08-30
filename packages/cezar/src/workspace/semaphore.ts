import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LockableRunner } from '@loki-labs/cezar-plus-contract';
import { DEFAULT_MONITORING_WAKE_MINUTES, loadWorkspaceConfig } from './config.ts';

/**
 * Workspace-wide resource governance (spec 2026-07-20-multi-project-workspace,
 * "Resource governance", step 2.5): `maxParallel` and `memoryLimitMb` protect
 * the *host*, not a repo, so they live in `~/.cezar/config.json` `resources`
 * and are enforced by ONE shared object across every `RunManager` — the boot
 * path constructs a single `WorkspaceSemaphore` and threads it through
 * `ProjectContexts` and the boot manager.
 *
 * Two jobs, deliberately fused because they cache the same file:
 *
 * 1. **Parallel cap** — `busy()` sums every registered manager's held slots;
 *    a manager's `pump()` starts queued runs only while `busy() <
 *    maxParallel()`. Slot accounting stays inside each manager (its
 *    `active + starting − waiting` count), which is what carries the #347
 *    exemption verbatim: a `waiting` run holds no slot, and a message into a
 *    waiting run resumes it immediately even when that momentarily exceeds
 *    the cap — a resume must never wait on other projects' runs.
 * 2. **Cached resource config** — `maxParallel()`/`memoryLimitMb()` answer
 *    from an in-memory snapshot, NOT the file: the memory guard ticks ~every
 *    2 s per manager, and N projects re-reading `~/.cezar/config.json` every
 *    tick is exactly what the spec forbids. `refresh()` is the single cache
 *    hook: boot calls it once, and `PUT /api/workspace/config` (step 2.7)
 *    calls it after a write — it re-reads the file and pumps every manager so
 *    a raised cap starts queued runs without a restart.
 *
 * Per-repo legacy `maxParallel`/`memoryLimitMb` keys are ignored by
 * enforcement post-migration (`loadConfig` still parses them for old files;
 * nothing consults them here).
 */

/** The cached workspace POLICY run enforcement consults, of which the `resources` slice is one
 *  kind — the bag is not renamed for carrying `runnerLock` too, since `@loki-labs/cezar-plus`
 *  is published and `BACKWARD_COMPATIBILITY.md` applies. */
export interface WorkspaceResourceLimits {
  /** Workspace-wide cap on concurrently *running* agent runs. */
  maxParallel: number;
  /**
   * Workspace-wide cap on runs inside a CPU/memory-heavy step at once — the SECOND admission
   * number (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D14). `maxParallel` bounds
   * how many runs are admitted at all; this bounds how many of them may be spiking together.
   *
   * **Absent means UNBOUNDED, never 0/1/2.** Mirrors `resources.maxHeavySteps` in `config.ts`
   * verbatim — that docblock is the reasoning; read it before touching this key. An older `load`
   * stub that predates this field, or a config file nobody has opted into the gate on, must behave
   * exactly like today's cezar: no second gate at all.
   */
  maxHeavySteps?: number;
  /** Durable monitoring sessions that do not consume active-task capacity. */
  maxMonitoringSessions?: number;
  /** Automatic monitoring re-check cadence in minutes. Default ON at
   *  `DEFAULT_MONITORING_WAKE_MINUTES`; explicit `null` means stay parked; absent means
   *  "this loader predates the key" and reads as the default. */
  monitoringWakeIntervalMinutes?: number | null;
  /** Resume a run stopped by a provider usage limit when that limit resets. Default ON. */
  autoResumeOnUsageLimit?: boolean;
  /** Start a task on another account when the one it NAMED is limited, rather than waiting.
   *  **CORRECTED 2026-08-29 (`.ai/specs/2026-08-29-global-provider-toggle.md`): the actual default
   *  has been ON since `.ai/specs/2026-08-23-never-block-a-task.md`** (`DEFAULT_LIMITS` below sets
   *  `true`, and the `fallbackAcrossAccountsWhenLimited()` accessor is `?? true`) — see that
   *  accessor's own doc comment for the reasoning. Original text, now describing only the state
   *  before that spec shipped: ~~Default OFF: overriding an explicit pick is a product decision,
   *  not a bug fix.~~ */
  fallbackAcrossAccountsWhenLimited?: boolean;
  /** Per-task process-tree memory ceiling in MiB; null = no limit. */
  memoryLimitMb: number | null;
  /**
   * Per-project concurrency ceilings, keyed by realpath-normalized project
   * root (the registry stores normalized `root`). A root absent from the map
   * inherits the workspace `maxParallel`. Optional so older `load` stubs that
   * only return the resource slice keep working — an absent map means "no
   * project has an override", i.e. every project inherits.
   */
  projectLimits?: ReadonlyMap<string, number>;
  /** The global provider lock (`.ai/specs/2026-08-29-global-provider-toggle.md`), a top-level
   *  `~/.cezar/config.json` key, NOT a `resources` key — carried in this bag because the run loop
   *  needs the same synchronous, live-applied read `maxParallel`/`fallbackAcrossAccountsWhenLimited`
   *  already get. Absent/`undefined` = Auto. */
  runnerLock?: LockableRunner;
}

/** Realpath-normalize a root the same way the registry does
 *  (`workspace/projects.ts` `normalizeRoot`), but synchronously — this answers
 *  a manager's hot-path lookup and must not `await`. A path that cannot be
 *  realpath'd degrades to `resolve()`, matching the registry's own fallback. */
function normalizeRootSync(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/**
 * The two kinds of usage-limit hold an account can be under, kept apart because they bind
 * different work (spec 2026-08-03-auto-resume-after-usage-limit):
 *
 *  - `deadline` — a run is parked on a reset instant that has not arrived. The window is known to
 *    be shut, so this blocks EVERYTHING on that account, resumes included.
 *  - `inFlight` — a resume is running right now, re-testing the window. Nothing is proven yet, so
 *    this blocks fresh work but NOT other resumes: a resume blocked by a resume is the deadlock
 *    that stopped a live workspace dead.
 */
export interface AccountHolds {
  deadline: ReadonlySet<string>;
  inFlight: ReadonlySet<string>;
}

/** One manager's seam into the shared counter. */
export interface SemaphoreParticipant {
  /** Slots this manager currently holds. The #347 exemption lives in the
   *  participant's own accounting: `waiting` runs are already subtracted. */
  busySlots(): number;
  /** Kick the manager's queue — capacity may have appeared. Awaited by
   *  `release()` so the manager taking a freed slot has registered it before
   *  the next participant evaluates capacity. */
  pump(): void | Promise<void>;
  /** Epoch ms of this manager's oldest queued run, or null when its queue is
   *  empty — `release()`'s ordering key, so a freed slot goes to the
   *  workspace's longest-waiting run instead of whichever manager happens to
   *  have registered first. */
  oldestQueuedAt(): number | null;
  /**
   * Agent accounts this participant is holding, by KIND (spec
   * 2026-08-03-auto-resume-after-usage-limit, `RunManager.accountHolds`).
   *
   * Workspace-scoped for the same reason the parallel cap is: a limit closes an ACCOUNT, and one
   * account can be driving tasks in several projects at once. Optional so a stub participant —
   * and any caller that predates the hold — keeps working; absent simply holds nothing.
   */
  accountHolds?(): AccountHolds;
  /**
   * Runs this participant is executing right now, per agent account (`accountUsageKey`).
   *
   * Here rather than plumbed from the server for one structural reason: **every** manager in the
   * workspace registers with this semaphore, the boot project's included. A reader assembled from
   * the project-context map instead would silently miss the boot repo — `resolveProjectScope`
   * short-circuits it, so it never enters that map — and the boot repo is where workspace runs
   * live. That exact miss already shipped once in the sidebar panel's count; see the spec's
   * "In-flight counting must include the boot project". Registration cannot forget a participant.
   *
   * Optional like `accountHolds`, and absent means "contributes nothing" rather than zero-for-all.
   */
  accountInflight?(): Record<string, number>;
  /**
   * The workspace `runnerLock` just CHANGED (D7a/D3b item 2,
   * `.ai/specs/2026-08-29-global-provider-toggle.md`) — fired by `refresh()` only on an actual
   * transition, and only BEFORE the sweep it then runs, so a memo naming a stale verdict about
   * the OLD target is never read by that sweep. `RunManager`'s implementation drops
   * `heldAtSpawn`/`heldNotified` for every queued run whose target the lock changes, the same
   * action `retargetQueuedRun` already takes for the identical reason (a memo is a verdict about
   * a specific account, and the lock write retargets every run it applies to).
   *
   * Optional exactly like `accountHolds`/`accountInflight`, so a stub participant or an older
   * caller keeps working: an unimplemented hook does nothing, which is why declaring it here (a
   * "no behaviour change" phase) and filling it in `RunManager` (a later phase) is safe to split.
   */
  onRunnerLockChanged?(): void;
}

const DEFAULT_LIMITS: WorkspaceResourceLimits = {
  maxParallel: 2,
  maxMonitoringSessions: 2,
  monitoringWakeIntervalMinutes: DEFAULT_MONITORING_WAKE_MINUTES,
  autoResumeOnUsageLimit: true,
  fallbackAcrossAccountsWhenLimited: true,
  memoryLimitMb: null,
};

/** Production loader: the `resources` slice of `~/.cezar/config.json`
 *  (schema-defaulted, so a missing/corrupt file yields the zero-config
 *  2 parallel / 2 monitoring / 5-minute wake / no memory cap),
 *  plus the per-project `maxParallel` overrides built into a root→limit map.
 *  The registry `root` is already realpath-normalized (`registerProject`), so
 *  the keys match `normalizeRootSync`'s output at lookup time. */
async function loadResourceLimits(): Promise<WorkspaceResourceLimits> {
  const { resources, projects, runnerLock } = await loadWorkspaceConfig();
  const projectLimits = new Map<string, number>();
  for (const project of projects) {
    if (typeof project.maxParallel === 'number') projectLimits.set(project.root, project.maxParallel);
  }
  return {
    maxParallel: resources.maxParallel,
    // `resources.maxHeavySteps` is itself `optional().catch(undefined)` (config.ts) — pass it
    // through verbatim rather than defaulting it here, or this loader would be the second place
    // (besides the schema) that has to remember absent means unbounded.
    maxHeavySteps: resources.maxHeavySteps,
    maxMonitoringSessions: resources.maxMonitoringSessions,
    monitoringWakeIntervalMinutes: resources.monitoringWakeIntervalMinutes,
    autoResumeOnUsageLimit: resources.autoResumeOnUsageLimit,
    fallbackAcrossAccountsWhenLimited: resources.fallbackAcrossAccountsWhenLimited,
    memoryLimitMb: resources.memoryLimitMb,
    projectLimits,
    // Top-level key, not a `resources` key (D7) — `null`/absent both normalize to `undefined` here,
    // so `refresh()`'s transition check never sees a difference between them.
    runnerLock: runnerLock ?? undefined,
  };
}

export interface WorkspaceSemaphoreOptions {
  /** Snapshot source for `refresh()` — tests inject a stub; production keeps
   *  the `~/.cezar/config.json` reader. */
  load?: () => Promise<WorkspaceResourceLimits>;
  /** Starting cache, before any `refresh()` — defaults to the workspace
   *  schema's own defaults (`maxParallel: 2`, no memory limit), so a manager
   *  constructed without boot wiring behaves like a fresh workspace. */
  initial?: Partial<WorkspaceResourceLimits>;
}

export class WorkspaceSemaphore {
  private readonly participants = new Set<SemaphoreParticipant>();
  private readonly load: () => Promise<WorkspaceResourceLimits>;
  private limits: WorkspaceResourceLimits;
  /** A `release()` sweep is in flight — see `pendingRelease`. */
  private broadcasting = false;
  /** A slot freed DURING a sweep. The in-flight sweep may already have pumped
   *  the manager that should get it, so re-run rather than drop the wakeup. */
  private pendingRelease = false;
  /** Heavy steps currently holding a slot — the SECOND gate (D14), counted separately from
   *  `busy()` because it is taken and released around a STEP, not a run. Deliberately its own
   *  counter rather than a `SemaphoreParticipant`: participants exist so a freed run slot can
   *  route to the workspace's longest-waiting queue across projects, and a heavy step has no
   *  project-scoped queue to route to — every waiter is equally entitled to the next free slot. */
  private heavyActiveCount = 0;
  /** FIFO queue of heavy-step waiters, each woken by `releaseHeavyStep()` popping one entry. A
   *  plain array rather than reusing `participants`' pump-and-poll shape: there is exactly one
   *  cap to satisfy here, not N managers each deciding independently whether they can start. */
  private readonly heavyWaiters: Array<() => void> = [];

  constructor(options: WorkspaceSemaphoreOptions = {}) {
    this.load = options.load ?? loadResourceLimits;
    this.limits = { ...DEFAULT_LIMITS, ...options.initial };
  }

  /** Join the shared counter. Returns the unregister handle — the manager's
   *  `dispose()` must call it so a torn-down project stops counting. */
  register(participant: SemaphoreParticipant): () => void {
    this.participants.add(participant);
    return () => this.participants.delete(participant);
  }

  /** Slots held across EVERY registered manager (waiting runs excluded by
   *  each participant — the #347 rule). */
  busy(): number {
    let total = 0;
    for (const participant of this.participants) total += participant.busySlots();
    return total;
  }

  /** Cached workspace-wide parallel cap. */
  maxParallel(): number {
    return this.limits.maxParallel;
  }

  /**
   * Cached cap on concurrent CPU/memory-heavy steps across the whole workspace (D14). This is
   * the ONE place that turns "absent" into "no gate" — every other reader of `limits.maxHeavySteps`
   * must go through this getter rather than re-deriving the fallback, per `WorkspaceResourceLimits`'
   * docblock: absent means UNBOUNDED, never 0, 1 or 2. A schema default would silently cap every
   * installed user's concurrent heavy steps the moment they upgraded `@loki-labs/cezar-plus`.
   */
  maxHeavySteps(): number {
    return this.limits.maxHeavySteps ?? Infinity;
  }

  /** Heavy steps holding a slot right now, across the whole workspace — the `heavyActive` half of
   *  D14's two presence numbers (`active/maxParallel`, `heavyActive/maxHeavySteps`). */
  heavyActive(): number {
    return this.heavyActiveCount;
  }

  /**
   * Run `fn` while holding a heavy-step slot (D14), queueing rather than failing when the gate is
   * full — "queueing at the gate is expected and correct; thrashing is not." A step never opts
   * into this call because of its NAME; the caller (the workflow runner, wiring the `heavy: true`
   * flag from `workflows/types.ts`) decides which steps pass through it. A step that never calls
   * this is never gated, at any occupancy.
   *
   * The slot is released in a `finally`, so a step that throws still frees it — a leaked slot here
   * wedges every future heavy step on the box behind a step that already failed. This is why the
   * method wraps `fn` rather than exposing bare acquire/release: a caller cannot forget the
   * `finally` if there is nothing to remember.
   *
   * Composes with the run-admission gate (`busy()`/`register()`/`release()`) without deadlock
   * because the two counters share no lock: a run already holding a run slot and now waiting here
   * blocks nothing but its own continuation — `release()`'s broadcast sweep, and every other heavy
   * step's acquire/release, run independently of this queue.
   */
  async runHeavyStep<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireHeavyStep();
    try {
      return await fn();
    } finally {
      this.releaseHeavyStep();
    }
  }

  /** Resolves immediately if a slot is free, else queues and resolves once `releaseHeavyStep()`
   *  pops this waiter — FIFO, so a step that has been waiting longest goes first. */
  private acquireHeavyStep(): Promise<void> {
    if (this.heavyActiveCount < this.maxHeavySteps()) {
      this.heavyActiveCount += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolveWaiter) => {
      this.heavyWaiters.push(() => {
        this.heavyActiveCount += 1;
        resolveWaiter();
      });
    });
  }

  /** Frees the slot this call held, then hands it straight to the next waiter (if any) — never
   *  drops back to zero occupancy while someone is still queued. */
  private releaseHeavyStep(): void {
    this.heavyActiveCount -= 1;
    const next = this.heavyWaiters.shift();
    if (next) next();
  }

  maxMonitoringSessions(): number {
    return this.limits.maxMonitoringSessions ?? 2;
  }

  /** Cadence for automatic monitoring re-checks, or null when the operator chose "park
   *  until resumed". Deliberately NOT `?? DEFAULT`: `null` is a real user choice and
   *  `null ?? 5` would silently override it (#810). Only an ABSENT key — an older `load`
   *  stub, a partial `initial` — falls back to the shipped default. */
  monitoringWakeIntervalMinutes(): number | null {
    const configured = this.limits.monitoringWakeIntervalMinutes;
    return configured === undefined ? DEFAULT_MONITORING_WAKE_MINUTES : configured;
  }

  /** Whether a usage-limit stop schedules its own resume. Absent (an older `load` stub, a config
   *  written before the key existed) reads as ON — the shipped default. */
  autoResumeOnUsageLimit(): boolean {
    return this.limits.autoResumeOnUsageLimit ?? true;
  }

  /** Absent reads as ON, since `.ai/specs/2026-08-23-never-block-a-task.md` — the owner's ruling
   *  that a task is never blocked by a limit, so availability outranks an explicit account pick.
   *  It read as OFF when the setting shipped (2026-08-23, earlier the same day), on the reasoning
   *  that overriding a named account is a product decision rather than a bug fix; that decision
   *  has since been made. Must stay in step with `resourcesSchema`'s `.default(true).catch(true)`
   *  and with the settings UI's `?? true`: a stub `load` reaching a different answer from the
   *  parsed config is a switch that lies about what the engine will do. */
  fallbackAcrossAccountsWhenLimited(): boolean {
    return this.limits.fallbackAcrossAccountsWhenLimited ?? true;
  }

  /** Cached per-task memory ceiling (MiB), or null for no limit. */
  memoryLimitMb(): number | null {
    return this.limits.memoryLimitMb;
  }

  /** The global provider lock, read SYNCHRONOUSLY from the in-memory snapshot
   *  (`.ai/specs/2026-08-29-global-provider-toggle.md`, D7): a recovery-sweep predicate
   *  (`run.ts:2956`) consults this on every tick and must never `readFile`. `undefined` = Auto,
   *  identical to every other accessor's "absent" convention in this class. */
  runnerLock(): LockableRunner | undefined {
    return this.limits.runnerLock;
  }

  /**
   * Every agent account held across the WHOLE workspace, by kind — the union of what each manager
   * reports (spec 2026-08-03-auto-resume-after-usage-limit). A `pump()` consults this before
   * starting a queued run, so a limit hit in one project also stops the same account being walked
   * into the wall from another.
   *
   * Asked live rather than cached: the underlying answer is derived from run records that change
   * on every schedule, resume and cancel, and a stale snapshot here would either stall a queue
   * whose window has reopened or leak a stampede through one that has not.
   */
  accountHolds(): AccountHolds {
    const deadline = new Set<string>();
    const inFlight = new Set<string>();
    for (const participant of this.participants) {
      const holds = participant.accountHolds?.();
      if (!holds) continue;
      for (const key of holds.deadline) deadline.add(key);
      for (const key of holds.inFlight) inFlight.add(key);
    }
    return { deadline, inFlight };
  }

  /**
   * Runs in flight across the WHOLE workspace, per agent account — the pool balancer's signal 2.
   *
   * Summed across participants, not unioned like `accountHolds`: a hold is a boolean fact about an
   * account ("closed"), while this is a quantity, and two projects each running one task on the
   * same login is two runs on it. Asked live for `accountHolds`'s reason — the answer changes on
   * every schedule, resume and cancel, and a cached one would route into an account that is already
   * saturated.
   */
  accountInflight(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const participant of this.participants) {
      const counts = participant.accountInflight?.();
      if (!counts) continue;
      for (const [key, count] of Object.entries(counts)) totals[key] = (totals[key] ?? 0) + count;
    }
    return totals;
  }

  /**
   * A slot came free somewhere in the workspace: pump EVERY manager,
   * longest-waiting-queue first.
   *
   * This is the counterpart to `busy()` being workspace-wide. A `RunManager`
   * only ever pumps itself, so before this existed a freed slot reached
   * exactly one project's queue: a run queued in project B stayed `queued`
   * while project A's runs came and went, until B happened to start or finish
   * a run of its own (or someone saved the workspace config). Every
   * slot-freeing transition — a run settling, a session parking at `waiting`
   * — routes here instead.
   *
   * Pumps are awaited in turn so the manager that takes the slot has it
   * counted (`starting`) before the next manager evaluates capacity — two
   * managers pumping concurrently could both read the same free slot and
   * overshoot `maxParallel`. Ordering is best-effort fairness, not a global
   * FIFO gate: a manager whose head-of-queue can't start (non-git root,
   * spec 006 degradation) must never block the rest of the workspace.
   */
  async release(): Promise<void> {
    if (this.broadcasting) {
      this.pendingRelease = true;
      return;
    }
    this.broadcasting = true;
    try {
      do {
        this.pendingRelease = false;
        const ordered = [...this.participants]
          .map((participant) => ({
            participant,
            // Empty queues sort last — they have nothing to claim the slot with.
            since: participant.oldestQueuedAt() ?? Number.MAX_SAFE_INTEGER,
          }))
          .sort((a, b) => a.since - b.since);
        for (const { participant } of ordered) await participant.pump();
      } while (this.pendingRelease);
    } finally {
      this.broadcasting = false;
    }
  }

  /**
   * The effective per-project concurrency cap for a manager's repo root: the
   * project's own `maxParallel` if set in the registry, else the workspace cap
   * (`maxParallel()`). Answered from the cached snapshot — the class's
   * no-per-tick-file-read invariant is preserved; the only syscall is a
   * `realpathSync` to key the lookup the same way the registry normalizes
   * `root` (once per `pump()`, alongside the existing `getRepoInfo` stat). A
   * root with no registry entry (an ad-hoc run outside the registry) has no
   * override and inherits the workspace cap.
   */
  projectMaxParallel(repoRoot: string): number {
    const override = this.limits.projectLimits?.get(normalizeRootSync(repoRoot));
    return override ?? this.maxParallel();
  }

  /**
   * The workspace resource-cache hook: re-read the config and pump every
   * registered manager, so a config change takes effect without a restart.
   * Called at boot and by `PUT /api/workspace/config` (step 2.7). A failed
   * read keeps the last good cache — enforcement never degrades to unlimited
   * because the file was momentarily unreadable.
   */
  async refresh(): Promise<void> {
    // D7a: `refresh()` fires from boot, a `maxParallel` PATCH and any workspace-config PUT — only
    // one of which can ever carry a lock — so the `onRunnerLockChanged` fan-out below must be
    // gated on an ACTUAL transition, never on "refresh happened", or it would drop every queued
    // run's held-account memo on an unrelated settings save.
    const previousRunnerLock = this.limits.runnerLock;
    let loaded: WorkspaceResourceLimits;
    try {
      loaded = await this.load();
    } catch {
      // keep the last good snapshot — the lock did not change, so no hook fires below.
      await this.release();
      return;
    }
    this.limits = loaded;
    // `null`/absent both normalize to `undefined` (`loadResourceLimits`), so clearing an
    // already-clear lock is not a transition either.
    if (loaded.runnerLock !== previousRunnerLock) {
      // BEFORE `release()`: the memos must be stale-free before the pump that reads them runs,
      // or the first sweep after a lock change still holds runs back on the old verdict.
      for (const participant of this.participants) participant.onRunnerLockChanged?.();
    }
    // A raised cap is capacity appearing everywhere at once — same sweep.
    await this.release();
  }
}
