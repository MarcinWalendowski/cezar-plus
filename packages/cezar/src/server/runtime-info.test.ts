import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureSpoolDir, spoolDirFor, writeSpoolMeta } from '../core/run-spool.ts';
import { HEALTH_SPOOL_SCAN_MAX, scanRunBrokers } from './runtime-info.ts';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-runtime-brokers-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'runs'));
  return dir;
}

describe('scanRunBrokers', () => {
  it('reports live brokers and run ids with more than one', () => {
    const dataDir = scratch();
    for (const instanceId of ['i1', 'i2']) {
      const spool = spoolDirFor(join(dataDir, 'runs'), 'run-a', instanceId);
      ensureSpoolDir(spool);
      writeSpoolMeta(spool, {
        schema: 1,
        protocol: 2,
        runId: 'run-a',
        backend: 'claude',
        pid: process.pid,
        argv: [],
        instanceId,
      });
    }
    expect(scanRunBrokers(dataDir)).toEqual({ live: 2, runsWithMultipleBrokers: ['run-a'] });
  });

  it('omits the field when the bounded scan would be exceeded', () => {
    const dataDir = scratch();
    for (let i = 0; i <= HEALTH_SPOOL_SCAN_MAX; i += 1) {
      mkdirSync(spoolDirFor(join(dataDir, 'runs'), 'run-a', `i${i}`), { recursive: true });
    }
    expect(scanRunBrokers(dataDir)).toBeUndefined();
  });
});
