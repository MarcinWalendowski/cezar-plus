import { describe, expect, it } from 'vitest';
import { testAttestationSchema } from './runs.ts';

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
