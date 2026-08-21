import { describe, expect, it } from 'vitest';
import { parseReviewVerdict, SPEC_TO_DEPLOY_WORKFLOW } from './types.ts';

/**
 * The spec reviewer's `CEZ:REVIEW` verdict (spec
 * `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`, P2).
 *
 * This marker is the half of the review that has teeth at the SHIPPED DEFAULT — the human gate
 * defaults to auto-approved — so its parsing rules are the feature, not a detail.
 */
describe('parseReviewVerdict', () => {
  it('reads a verdict on the last line', () => {
    expect(parseReviewVerdict('Looks good.\n\nCEZ:REVIEW=pass')).toBe('pass');
    expect(parseReviewVerdict('Three defects.\n\nCEZ:REVIEW=revise')).toBe('revise');
  });

  it('tolerates trailing whitespace, spacing around the =, and case', () => {
    expect(parseReviewVerdict('CEZ:REVIEW = revise   \n\n')).toBe('revise');
    expect(parseReviewVerdict('cez:review=PASS')).toBe('pass');
  });

  it('returns undefined when the turn declared nothing', () => {
    expect(parseReviewVerdict('I read the spec and it seems fine.')).toBeUndefined();
    expect(parseReviewVerdict('')).toBeUndefined();
  });

  it('ignores a marker MENTIONED mid-report rather than declared at the end', () => {
    // The reviewer's own prompt quotes both markers, and a spec may quote the syntax too. Reading
    // from the end is what stops "I will end with CEZ:REVIEW=revise if I find anything" from
    // being read as the verdict itself.
    const mentioned = 'I was told to end with CEZ:REVIEW=revise if there are defects.\n\nThere are none.';
    expect(parseReviewVerdict(mentioned)).toBeUndefined();
  });

  it('takes the LAST verdict when a turn somehow contains two', () => {
    expect(parseReviewVerdict('CEZ:REVIEW=revise\nOn reflection:\nCEZ:REVIEW=pass')).toBe('pass');
  });

  it('rejects a verdict word the workflow never offered', () => {
    expect(parseReviewVerdict('CEZ:REVIEW=maybe')).toBeUndefined();
    expect(parseReviewVerdict('CEZ:REVIEW=')).toBeUndefined();
  });
});

describe('the review step and the parser agree on the vocabulary', () => {
  it('parses both verdicts the review prompt actually asks for', () => {
    // A drift guard: if the prompt ever offers a third word, or renames one, this fails rather
    // than silently teaching the reviewer a marker the engine cannot read.
    const prompt = SPEC_TO_DEPLOY_WORKFLOW.steps.find((s) => s.id === 'review-spec')?.prompt ?? '';
    const offered = [...prompt.matchAll(/CEZ:REVIEW=(\w+)/g)].map((m) => m[1]);
    expect(offered.length).toBeGreaterThan(0);
    for (const word of offered) {
      expect(parseReviewVerdict(`verdict:\nCEZ:REVIEW=${word}`)).toBe(word);
    }
  });
});
