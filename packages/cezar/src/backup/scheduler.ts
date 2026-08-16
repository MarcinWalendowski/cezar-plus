import { DueScheduler } from '../scheduling/due-scheduler.ts';
import { loadBackupConfig } from './config.ts';
import { runBackup, type BackupEngineDeps } from './snapshot.ts';

/**
 * Wraps `DueScheduler` (`../scheduling/due-scheduler.ts`, W1.6) so a scheduled tick runs
 * `runBackup` every `intervalMinutes` (`backup.json`, Data Models — default 15). Mirrors
 * `WorkspaceAutomationScheduler` / the source-sync scheduler: `DueScheduler.collectDue` must be
 * synchronous, so `intervalMinutes` is read from config once before arming and again after every
 * run (right before `DueScheduler` re-arms in its own `.finally`), rather than on every
 * `collectDue()` call.
 *
 * Not wired into any boot file here — the orchestrator constructs and `start()`s this only when
 * `CEZ_BACKUP=1` is set, so an unconfigured/flag-off cezar never arms a timer (N1).
 */
export class BackupScheduler {
  private readonly due: DueScheduler<void>;
  private intervalMinutes = 15;

  constructor(
    private readonly deps: BackupEngineDeps,
    private readonly now: () => number = Date.now,
  ) {
    this.due = new DueScheduler<void>({
      collectDue: () => [{ at: this.now() + this.intervalMinutes * 60_000, value: undefined }],
      run: async () => {
        try {
          await runBackup(this.deps);
        } catch (error) {
          console.error('[cez] scheduled backup run failed:', error);
        } finally {
          await this.refreshInterval();
        }
      },
      now: this.now,
    });
  }

  /** Marks the scheduler active and arms the first tick, after reading the current interval. */
  async start(): Promise<void> {
    await this.refreshInterval();
    this.due.start();
    this.due.schedule();
  }

  stop(): void {
    this.due.stop();
  }

  private async refreshInterval(): Promise<void> {
    try {
      const config = await loadBackupConfig();
      this.intervalMinutes = config.intervalMinutes;
    } catch {
      // Keep the previously-known interval — a read hiccup shouldn't stop the scheduler.
    }
  }
}
