/** One entry that becomes eligible to run at `at` (epoch ms). */
export interface DueEntry<T> {
  at: number;
  value: T;
}

export interface DueSchedulerOptions<T> {
  /** Recomputed every time the scheduler (re)arms. Synchronous: a caller that needs to
   * refresh async state first (e.g. project discovery) does so before calling `schedule()`,
   * not inside `collectDue`. */
  collectDue: () => ReadonlyArray<DueEntry<T>>;
  /** Runs the earliest-due entry. Errors are swallowed; the scheduler always recomputes
   * and re-arms afterward, unless stopped in the meantime. */
  run: (value: T) => Promise<unknown>;
  now?: () => number;
}

/**
 * Collects due entries, sorts them, and arms exactly one `setTimeout` for the earliest,
 * re-arming on completion. Extracted from `WorkspaceAutomationScheduler`
 * (`packages/cezar/src/automations/scheduler.ts`) so a second subsystem (source sync,
 * W4.4) can reuse the same mechanism without depending on anything automation-shaped.
 *
 * Source-agnostic: the caller owns discovery, entry collection, and what "run" means.
 */
export class DueScheduler<T> {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;

  constructor(private readonly options: DueSchedulerOptions<T>) {}

  /** Marks the scheduler active. Does not itself arm a timer: call `schedule()` once the
   * caller's own due-collecting state is ready. */
  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  /** Clears any pending timer without marking the scheduler stopped. For a caller that
   * needs to refresh async state before recomputing the due set. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  hasTimer(): boolean { return this.timer !== undefined; }

  /** Recompute the due set and arm exactly one timer for the earliest entry. */
  schedule(): void {
    if (this.stopped) return;
    const due = [...this.options.collectDue()];
    if (!due.length) return;
    due.sort((a, b) => a.at - b.at);
    const next = due[0]!;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.options.run(next.value).catch(() => undefined).finally(() => this.schedule());
    }, Math.max(0, next.at - (this.options.now?.() ?? Date.now())));
  }
}
