import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { brokerScopeUnitName, userScopeEnv } from './broker-isolation.ts';
import type { SpoolMeta } from './run-spool.ts';

const execFileAsync = promisify(execFile);

export interface ReapAbandonedBrokerDeps {
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  stopUnit?: (unit: string) => Promise<void>;
}

/** Stop a broker the replacement server deliberately refused to adopt. */
export async function reapAbandonedBroker(
  runId: string,
  meta: SpoolMeta,
  deps: ReapAbandonedBrokerDeps = {},
): Promise<boolean> {
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); });
  try {
    kill(meta.pid, 'SIGKILL');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return false;
  }

  if (meta.instanceId) {
    const unit = brokerScopeUnitName(runId, meta.instanceId);
    const stopUnit = deps.stopUnit ?? (async (name: string) => {
      await execFileAsync('systemctl', ['--user', 'stop', name], { env: { ...process.env, ...userScopeEnv() } });
    });
    try {
      await stopUnit(unit);
    } catch {
      // The pid is already reaped. Unit cleanup is best-effort on non-systemd hosts.
    }
  }
  return true;
}
