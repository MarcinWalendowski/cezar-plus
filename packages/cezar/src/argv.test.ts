import { describe, expect, it } from 'vitest';
import { withOptionalFlagValues } from './argv.ts';

describe('withOptionalFlagValues', () => {
  it('rewrites a bare --rollback at the end of argv to --rollback=', () => {
    expect(withOptionalFlagValues(['server-deploy', '--rollback'])).toEqual([
      'server-deploy',
      '--rollback=',
    ]);
  });

  it('leaves --rollback r1 untouched (does not eat the next token)', () => {
    expect(withOptionalFlagValues(['--rollback', 'r1'])).toEqual(['--rollback', 'r1']);
  });

  it('leaves --rollback=r1 untouched', () => {
    expect(withOptionalFlagValues(['--rollback=r1'])).toEqual(['--rollback=r1']);
  });

  it('leaves everything after a -- terminator untouched', () => {
    expect(withOptionalFlagValues(['server-deploy', '--', '--rollback'])).toEqual([
      'server-deploy',
      '--',
      '--rollback',
    ]);
  });

  it('rewrites --rollback followed by another flag (the ambiguous shape)', () => {
    expect(withOptionalFlagValues(['--rollback', '--dry-run'])).toEqual(['--rollback=', '--dry-run']);
  });
});
