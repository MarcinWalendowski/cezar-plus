import { describe, expect, it } from 'vitest';
import { applyRunnerLock } from './runner-lock.ts';

describe('applyRunnerLock', () => {
  it('is the identity when no lock is set — unset is byte-for-byte today', () => {
    expect(applyRunnerLock(undefined, 'codex')).toEqual({
      runner: 'codex',
      locked: false,
      wouldHaveBeen: 'codex',
    });
  });

  it('overrides the request when the lock names a different provider', () => {
    expect(applyRunnerLock('claude', 'codex')).toEqual({
      runner: 'claude',
      locked: true,
      wouldHaveBeen: 'codex',
    });
  });

  it('is not "locked" when the lock agrees with the request', () => {
    const result = applyRunnerLock('claude', 'claude');
    expect(result.runner).toBe('claude');
    expect(result.locked).toBe(false);
    expect(result.wouldHaveBeen).toBe('claude');
  });
});
