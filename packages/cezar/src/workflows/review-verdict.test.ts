import { describe, expect, it } from 'vitest';
import { specRevisionFeedback } from './run.ts';
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

  // Pinned per review iteration 2's nit (spec .ai/specs/2026-08-21-structured-review-targeted-
  // spec-edits.md): the FILE/SECTION/CHANGE shape now shows `CEZ:REVIEW=` markers by example
  // inside its own prompt text, and the drift guard above scans EVERY occurrence in the prompt —
  // so a future example block that mentions a verdict word the parser cannot read would silently
  // fail the loop above rather than this being noticed as a false negative. Explicit here so a
  // reader does not have to re-derive that the loop already covers this case.
  it('offers exactly the two verdict words, even with the change-list shape shown by example', () => {
    const prompt = SPEC_TO_DEPLOY_WORKFLOW.steps.find((s) => s.id === 'review-spec')?.prompt ?? '';
    const offered = [...prompt.matchAll(/CEZ:REVIEW=(\w+)/g)].map((m) => m[1]);
    expect(new Set(offered)).toEqual(new Set(['pass', 'revise']));
  });
});

/**
 * `specRevisionFeedback()` (spec .ai/specs/2026-08-21-structured-review-targeted-spec-edits.md,
 * § Solution 2): wraps a reviewer's (or human's) notes with the fixed instruction that makes a
 * change list something the `spec` step can act on mechanically — apply as targeted edits, don't
 * re-emit the whole file.
 */
describe('specRevisionFeedback', () => {
  const report = '1. FILE: .ai/specs/foo.md\n   SECTION: ## Risks\n   CHANGE: add a risk about X.';

  it('instructs targeted edits, forbids a full rewrite, and carries the report verbatim', () => {
    const feedback = specRevisionFeedback(report, '.ai/specs/foo.md');
    expect(feedback).toContain('TARGETED EDIT');
    expect(feedback).toContain('Do NOT re-emit');
    expect(feedback).toContain('byte-identical');
    expect(feedback).toContain(report);
  });

  it('points at the known spec path when one is given', () => {
    const feedback = specRevisionFeedback(report, '.ai/specs/foo.md');
    expect(feedback).toContain('.ai/specs/foo.md');
  });

  it('tells the model to locate the file rather than assume it is missing when no path is known', () => {
    const feedback = specRevisionFeedback(report);
    expect(feedback).toContain('This run never recorded its path');
    expect(feedback).toContain('Never write a second copy of the spec under a new path');
  });
});
