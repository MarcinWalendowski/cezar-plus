import { describe, expect, it, vi } from 'vitest';

import { brokerScopeUnitName } from './broker-isolation.ts';
import { reapAbandonedBroker } from './reap-abandoned-broker.ts';

describe('reapAbandonedBroker', () => {
  it('SIGKILLs before stopping the exact launch unit', async () => {
    const calls: string[] = [];
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => { calls.push(`kill:${pid}:${signal}`); });
    const stopUnit = vi.fn(async (unit: string) => { calls.push(`stop:${unit}`); });
    await expect(reapAbandonedBroker('run-1', {
      schema: 1,
      protocol: 2,
      runId: 'run-1',
      backend: 'claude',
      pid: 42,
      argv: [],
      instanceId: 'launch-2',
    }, { kill, stopUnit })).resolves.toBe(true);
    expect(calls).toEqual([
      'kill:42:SIGKILL',
      `stop:${brokerScopeUnitName('run-1', 'launch-2')}`,
    ]);
  });

  it('does not guess a unit for a protocol-1 broker', async () => {
    const stopUnit = vi.fn(async () => {});
    await reapAbandonedBroker('run-1', {
      schema: 1,
      protocol: 1,
      runId: 'run-1',
      backend: 'claude',
      pid: 42,
      argv: [],
    }, { kill: () => {}, stopUnit });
    expect(stopUnit).not.toHaveBeenCalled();
  });
});
