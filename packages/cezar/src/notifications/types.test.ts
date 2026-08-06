import { describe, expect, it } from 'vitest';
import { NOTIFICATION_EVENTS } from './types.ts';

describe('notifications/types', () => {
  it('is the closed 8-member event set from the spec, in order', () => {
    expect(NOTIFICATION_EVENTS).toEqual([
      'run.failed',
      'run.needs-you',
      'run.review',
      'run.finished',
      'run.usage-limit',
      'provider.auth-required',
      'queue.drained',
      'test',
    ]);
  });

  it('contains no permission.* member (Q7: nothing emits permission.requested)', () => {
    expect(NOTIFICATION_EVENTS.some((event) => event.startsWith('permission.'))).toBe(false);
  });

  // Negative control: prove the assertion above would actually catch a regression rather than
  // vacuously passing on any array.
  it('negative control: a permission.* member would fail the guard above', () => {
    const withRegression: readonly string[] = [...NOTIFICATION_EVENTS, 'permission.requested'];
    expect(withRegression.some((event) => event.startsWith('permission.'))).toBe(true);
  });
});
