import { describe, expect, it } from 'vitest';
import { stepStateSchema, testAttestationSchema } from './runs.ts';

describe('testAttestationSchema', () => {
  const legacy = {
    stepId: 'run-tests',
    treeSha: '1'.repeat(40),
    at: new Date().toISOString(),
  };

  it('keeps released single-tree attestations valid', () => {
    expect(testAttestationSchema.parse(legacy)).toEqual(legacy);
  });

  it('accepts per-project workspace trees', () => {
    expect(testAttestationSchema.parse({
      ...legacy,
      projects: [{
        root: '/projects/example',
        worktreePath: '/worktrees/example',
        treeSha: '2'.repeat(40),
        headSha: '3'.repeat(40),
      }],
    }).projects).toHaveLength(1);
  });
});

// spec 2026-08-29-per-retry-step-timing: `attempts` is additive, so a pre-ship record with no key
// at all must still parse, and a record that carries one must round-trip unchanged.
describe('stepStateSchema — attempts (spec 2026-08-29-per-retry-step-timing)', () => {
  const base = {
    id: 'work',
    name: 'Work',
    kind: 'agent' as const,
    status: 'running' as const,
    iterations: 2,
    tokensUsed: 0,
  };

  it('parses a pre-ship record with no `attempts` key', () => {
    const parsed = stepStateSchema.parse(base);
    expect(parsed.attempts).toBeUndefined();
  });

  it('round-trips a record with `attempts` unchanged', () => {
    const withAttempts = {
      ...base,
      attempts: [
        { n: 1, startedAt: '2026-08-29T00:00:00.000Z', endedAt: '2026-08-29T00:00:02.000Z' },
        { n: 2, startedAt: '2026-08-29T00:00:03.000Z' },
      ],
    };
    expect(stepStateSchema.parse(withAttempts).attempts).toEqual(withAttempts.attempts);
  });
});
