import { describe, expect, it } from 'vitest';
import { detectTrailingQuestion, TRAILING_QUESTION_MAX_CHARS } from './turn-question.ts';

describe('detectTrailingQuestion', () => {
  it('detects a trailing sentence ending in "?"', () => {
    const result = detectTrailingQuestion('Opened a draft PR.\n\nMerge and deploy now, or hold for review?');
    expect(result?.text).toBe('Merge and deploy now, or hold for review?');
  });

  for (const cue of [
    'Let me know if this looks right',
    'Do you want me to proceed',
    'Would you like me to open a PR',
    'Should I merge this now',
    'Shall I continue',
    'Your call on the deploy',
    'Please confirm before I proceed',
    'Can you confirm the target branch',
    'I am waiting on you to decide',
    'Tell me which option you prefer',
    'Which do you want me to pick',
  ]) {
    it(`detects the decision cue: "${cue}"`, () => {
      const result = detectTrailingQuestion(`Everything else is done. ${cue}.`);
      expect(result).not.toBeNull();
    });
  }

  it('strips a trailing CEZ:PR= line before scanning', () => {
    const result = detectTrailingQuestion('Should I proceed?\nCEZ:PR=12');
    expect(result?.text).toBe('Should I proceed?');
  });

  it('clips a long question to 280 chars with an ellipsis', () => {
    const long = `Should I proceed with the following plan: ${'x'.repeat(400)}?`;
    const result = detectTrailingQuestion(long);
    expect(result).not.toBeNull();
    expect(result?.text.length).toBe(TRAILING_QUESTION_MAX_CHARS);
    expect(result?.text.endsWith('…')).toBe(true);
  });

  it('returns null for a report with no question', () => {
    expect(detectTrailingQuestion('Opened a draft PR and ran the gates. All green.')).toBeNull();
  });

  it('ignores a "?" inside a fenced code block', () => {
    const turn = 'Ran the script:\n\n```\ncurl https://example.com?x=1\n```\n\nAll gates green.';
    expect(detectTrailingQuestion(turn)).toBeNull();
  });

  it('scans only the tail paragraph — a "?" in an earlier paragraph does not count', () => {
    const turn = `Should I proceed with this?\n\n${'Filler line. '.repeat(50)}\n\nOpened a draft PR and ran the gates. All green.`;
    expect(detectTrailingQuestion(turn)).toBeNull();
  });

  it('excludes the bare "confirm" case', () => {
    expect(detectTrailingQuestion("I'll confirm the deploy once CI is green.")).toBeNull();
  });

  it('is total: empty string', () => {
    expect(detectTrailingQuestion('')).toBeNull();
  });

  it('is total: whitespace only', () => {
    expect(detectTrailingQuestion('   \n\n  \t ')).toBeNull();
  });

  it('is total: nothing but a CEZ:TITLE= line', () => {
    expect(detectTrailingQuestion('CEZ:TITLE=implementing the thing')).toBeNull();
  });
});
