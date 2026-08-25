import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

type MutableRegistry = {
  active: Map<string, unknown>;
  starting: Set<string>;
  queue: string[];
  waiting: Set<string>;
  monitoring: Set<string>;
  autoResumeTimers: Map<string, NodeJS.Timeout>;
  pendingJobs: Map<string, unknown>;
};

describe('RunManager.runLiveness', () => {
  let root: string | undefined;
  let manager: RunManager | undefined;

  afterEach(() => {
    manager?.dispose();
    if (root) rmSync(root, { recursive: true, force: true });
    manager = undefined;
    root = undefined;
  });

  function fixture(): { manager: RunManager; registry: MutableRegistry } {
    root = mkdtempSync(join(tmpdir(), 'cez-run-liveness-'));
    manager = new RunManager(RunStore.open(join(root, '.ai/cezar')), root);
    return { manager, registry: manager as unknown as MutableRegistry };
  }

  it.each([
    ['active', 'active step chain', (state: MutableRegistry) => state.active.set('run-1', {})],
    ['starting', 'starting', (state: MutableRegistry) => state.starting.add('run-1')],
    ['queue', 'queued', (state: MutableRegistry) => state.queue.push('run-1')],
    ['waiting', 'waiting for input', (state: MutableRegistry) => state.waiting.add('run-1')],
    ['monitoring', 'monitoring', (state: MutableRegistry) => state.monitoring.add('run-1')],
    ['auto-resume', 'auto-resume scheduled', (state: MutableRegistry) => state.autoResumeTimers.set('run-1', {} as NodeJS.Timeout)],
    ['pending-job', 'pending job', (state: MutableRegistry) => state.pendingJobs.set('run-1', {})],
  ])('reports the %s registry as live', (_source, reason, arrange) => {
    const { manager: subject, registry } = fixture();
    arrange(registry);
    expect(subject.runLiveness('run-1')).toEqual({ live: true, reason });
  });

  it('reports unknown and unregistered ids as not live without mutating registries', () => {
    const { manager: subject, registry } = fixture();
    const before = {
      active: registry.active.size,
      starting: registry.starting.size,
      queue: registry.queue.length,
      waiting: registry.waiting.size,
      monitoring: registry.monitoring.size,
      autoResume: registry.autoResumeTimers.size,
      pendingJobs: registry.pendingJobs.size,
    };

    expect(subject.runLiveness('unknown')).toEqual({
      live: false,
      reason: 'no active step, scheduled resume, or queued job',
    });
    expect(subject.runLiveness('running-but-unregistered')).toEqual({
      live: false,
      reason: 'no active step, scheduled resume, or queued job',
    });
    expect({
      active: registry.active.size,
      starting: registry.starting.size,
      queue: registry.queue.length,
      waiting: registry.waiting.size,
      monitoring: registry.monitoring.size,
      autoResume: registry.autoResumeTimers.size,
      pendingJobs: registry.pendingJobs.size,
    }).toEqual(before);
  });
});
