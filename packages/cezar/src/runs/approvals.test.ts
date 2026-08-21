import { describe, expect, it } from 'vitest';
import { approvalsSatisfied, minApprovers, MAX_APPROVERS } from './approvals.ts';

/**
 * The human approval gate's resolver (spec
 * `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`, P3).
 *
 * The load-bearing case is the FIRST one: the owner asked for "min 1, but by default it should be
 * 'auto approved'", so a zero-config install must resolve to 0 and never park. Every other case
 * here exists to stop something turning that default on by accident.
 */
describe('minApprovers', () => {
  it('is 0 — auto-approved — with no config and no env', () => {
    expect(minApprovers({}, {})).toBe(0);
  });

  it('lets the config value win over the env, including an explicit 0', () => {
    expect(minApprovers({ approvals: { minApprovers: 2 } }, { CEZ_MIN_APPROVERS: '5' })).toBe(2);
    // An explicit 0 is a DECISION ("auto-approve here"), not an absent key, so it must beat an
    // env that would otherwise switch the gate on.
    expect(minApprovers({ approvals: { minApprovers: 0 } }, { CEZ_MIN_APPROVERS: '3' })).toBe(0);
  });

  it('reads the env when the config says nothing', () => {
    expect(minApprovers({}, { CEZ_MIN_APPROVERS: '1' })).toBe(1);
    expect(minApprovers({ approvals: {} }, { CEZ_MIN_APPROVERS: '2' })).toBe(2);
  });

  it('fails OPEN on a malformed env rather than parking every run on the box', () => {
    for (const raw of ['', 'yes', 'true', '1.5', '-1', 'NaN', String(MAX_APPROVERS + 1)]) {
      expect(minApprovers({}, { CEZ_MIN_APPROVERS: raw })).toBe(0);
    }
  });
});

describe('approvalsSatisfied counts approvers, not clicks', () => {
  it('is trivially satisfied when nothing is required', () => {
    expect(approvalsSatisfied([], 0)).toBe(true);
    expect(approvalsSatisfied([], -1)).toBe(true);
  });

  it('needs one approval when one approver is required', () => {
    expect(approvalsSatisfied([], 1)).toBe(false);
    expect(approvalsSatisfied([{ by: 'ada' }], 1)).toBe(true);
  });

  it('does NOT let one person satisfy a two-approver gate by clicking twice', () => {
    // The honest limitation named in `approvals.ts`: on an unauthenticated install every approval
    // carries the same identity, so `minApprovers: 2` genuinely cannot be met — which is correct
    // for a setting whose name says "approvers", and is the behaviour this pins.
    expect(approvalsSatisfied([{ by: 'local' }, { by: 'local' }], 2)).toBe(false);
    expect(approvalsSatisfied([{ by: 'ada' }, { by: 'grace' }], 2)).toBe(true);
  });
});
