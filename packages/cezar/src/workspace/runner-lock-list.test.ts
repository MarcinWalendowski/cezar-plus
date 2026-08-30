import { LOCKABLE_RUNNERS } from '@loki-labs/better-cezar-contract';
import { describe, expect, it } from 'vitest';
import { PROFILE_CAPABLE_PROVIDERS } from '../core/agent-profiles.ts';

describe('LOCKABLE_RUNNERS', () => {
  // A runtime equality check, not a type assignment: `PROFILE_CAPABLE_PROVIDERS` is declared
  // `readonly ProviderId[]` (a widened type computed by `.filter()`), so
  // `const _a: LockableRunner[] = [...PROFILE_CAPABLE_PROVIDERS]` does not compile today and
  // `const _b: ProviderId[] = [...LOCKABLE_RUNNERS]` compiles forever and checks nothing. This
  // goes red the day a third provider becomes profile-capable, which is exactly when the lock,
  // the bar and the pool each need a decision rather than a silent widening.
  it('the lockable runners are exactly the profile-capable providers', () => {
    expect([...LOCKABLE_RUNNERS].sort()).toEqual([...PROFILE_CAPABLE_PROVIDERS].sort());
  });
});
