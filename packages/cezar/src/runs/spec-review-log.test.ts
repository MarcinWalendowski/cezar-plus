import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendSpecReviewEntry,
  readSpecReviewEntries,
  specReviewLogPath,
  summariseSpecReview,
  SPEC_SNAPSHOT_CAP,
} from './spec-review-log.ts';

/**
 * The spec/review feed's side log (`.ai/specs/2026-08-29-spec-tab-review-feed.md`, P1
 * Verification items 1-6).
 */
describe('spec-review-log', () => {
  let dataDir: string;
  let runId: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-spec-review-'));
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    runId = 'run-1';
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const readRawLines = () =>
    readFileSync(specReviewLogPath(dataDir, runId), 'utf8').split('\n').filter(Boolean);

  it('1. appends spec/review/spec/review and reads them back in order, with seq 0..3 and revision 1,1,2,2', () => {
    appendSpecReviewEntry(dataDir, runId, {
      kind: 'spec',
      stepId: 'spec',
      specPath: '.ai/specs/x.md',
      source: 'recorded',
      text: 'v1 text',
    });
    appendSpecReviewEntry(dataDir, runId, {
      kind: 'review',
      stepId: 'review-spec',
      actor: 'agent',
      verdict: 'revise',
      report: '1. FILE: .ai/specs/x.md\n   SECTION: ## Foo\n   CHANGE: fix it.',
    });
    appendSpecReviewEntry(dataDir, runId, {
      kind: 'spec',
      stepId: 'spec',
      specPath: '.ai/specs/x.md',
      source: 'recorded',
      text: 'v2 text',
    });
    appendSpecReviewEntry(dataDir, runId, {
      kind: 'review',
      stepId: 'review-spec',
      actor: 'agent',
      verdict: 'pass',
      report: 'looks good',
    });

    const entries = readSpecReviewEntries(dataDir, runId);
    expect(entries.map((e) => e.kind)).toEqual(['spec', 'review', 'spec', 'review']);
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(entries.map((e) => e.revision)).toEqual([1, 1, 2, 2]);
  });

  it('2. summariseSpecReview reports revisions/reviews/latestVerdict over the same fixture', () => {
    appendSpecReviewEntry(dataDir, runId, { kind: 'spec', stepId: 'spec', specPath: 'x.md', source: 'recorded', text: 'v1' });
    appendSpecReviewEntry(dataDir, runId, { kind: 'review', stepId: 'review-spec', actor: 'agent', verdict: 'revise', report: 'r1' });
    appendSpecReviewEntry(dataDir, runId, { kind: 'spec', stepId: 'spec', specPath: 'x.md', source: 'recorded', text: 'v2' });
    appendSpecReviewEntry(dataDir, runId, { kind: 'review', stepId: 'review-spec', actor: 'agent', verdict: 'pass', report: 'r2' });

    const summary = summariseSpecReview(readSpecReviewEntries(dataDir, runId));
    expect(summary).toEqual({ revisions: 2, reviews: 2, latestVerdict: 'pass' });
  });

  it('3. truncates a spec entry over SPEC_SNAPSHOT_CAP, keeping the head', () => {
    const huge = 'x'.repeat(SPEC_SNAPSHOT_CAP + 1);
    const entry = appendSpecReviewEntry(dataDir, runId, {
      kind: 'spec',
      stepId: 'spec',
      specPath: 'x.md',
      source: 'recorded',
      text: huge,
    });
    expect(entry.kind).toBe('spec');
    if (entry.kind !== 'spec') throw new Error('unreachable');
    expect(entry.truncated).toBe(true);
    expect(entry.text?.length).toBe(SPEC_SNAPSHOT_CAP);
  });

  it('3b. seq is (max VALID seq)+1, not entries.length, across a gap and past corruption', () => {
    const logPath = specReviewLogPath(dataDir, runId);
    appendFileSync(
      logPath,
      `${JSON.stringify({ seq: 0, at: 't', stepId: 'spec', kind: 'spec', revision: 1, specPath: 'x.md', source: 'recorded' })}\n`,
    );
    appendFileSync(logPath, '{ not json\n');
    appendFileSync(
      logPath,
      `${JSON.stringify({ seq: 4, at: 't', stepId: 'spec', kind: 'spec', revision: 2, specPath: 'x.md', source: 'recorded' })}\n`,
    );

    const beforeAppend = readSpecReviewEntries(dataDir, runId);
    expect(beforeAppend).toHaveLength(2); // the malformed line is skipped

    const appended = appendSpecReviewEntry(dataDir, runId, {
      kind: 'review',
      stepId: 'review-spec',
      actor: 'agent',
      verdict: 'pass',
      report: 'ok',
    });
    expect(appended.seq).toBe(5); // entries.length would have produced 2, colliding with nothing visible

    const rawSeqs = readRawLines()
      .map((line) => {
        try {
          return (JSON.parse(line) as { seq: number }).seq;
        } catch {
          return null; // the deliberately-malformed line, left in place on disk
        }
      })
      .filter((seq): seq is number => seq !== null);
    expect(rawSeqs).toEqual([0, 4, 5]);
    for (let i = 1; i < rawSeqs.length; i += 1) expect(rawSeqs[i]!).toBeGreaterThan(rawSeqs[i - 1]!);
  });

  it('3b (every line malformed) — the first successful append is seq 0', () => {
    const logPath = specReviewLogPath(dataDir, runId);
    appendFileSync(logPath, '{ not json at all\n');
    appendFileSync(logPath, 'also not json\n');

    expect(readSpecReviewEntries(dataDir, runId)).toEqual([]);
    const appended = appendSpecReviewEntry(dataDir, runId, {
      kind: 'spec',
      stepId: 'spec',
      specPath: 'x.md',
      source: 'recorded',
      text: 'v1',
    });
    expect(appended.seq).toBe(0);
  });

  describe('4. redaction', () => {
    const saved = { CEZ_SECRET_TEST_TOKEN: process.env.CEZ_SECRET_TEST_TOKEN, CEZ_REDACT_SECRETS: process.env.CEZ_REDACT_SECRETS };
    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('scrubs a known host secret value from the review report before it is written', () => {
      process.env.CEZ_SECRET_TEST_TOKEN = 'gho_thisisarealsecrettoken123456';
      delete process.env.CEZ_REDACT_SECRETS;
      appendSpecReviewEntry(dataDir, runId, {
        kind: 'review',
        stepId: 'review-spec',
        actor: 'agent',
        verdict: 'revise',
        report: 'found the token gho_thisisarealsecrettoken123456 hardcoded',
      });
      const raw = readRawLines().join('\n');
      expect(raw).not.toContain('gho_thisisarealsecrettoken123456');
      expect(raw).toContain('[REDACTED]');
    });

    it('CEZ_REDACT_SECRETS=0 opts out', () => {
      process.env.CEZ_SECRET_TEST_TOKEN = 'gho_thisisarealsecrettoken123456';
      process.env.CEZ_REDACT_SECRETS = '0';
      appendSpecReviewEntry(dataDir, runId, {
        kind: 'review',
        stepId: 'review-spec',
        actor: 'agent',
        verdict: 'revise',
        report: 'token gho_thisisarealsecrettoken123456',
      });
      expect(readRawLines().join('\n')).toContain('gho_thisisarealsecrettoken123456');
    });
  });

  it('5. malformed-line tolerance: a hand-written bad line does not throw and valid entries still read', () => {
    appendSpecReviewEntry(dataDir, runId, { kind: 'spec', stepId: 'spec', specPath: 'x.md', source: 'recorded', text: 'v1' });
    appendFileSync(specReviewLogPath(dataDir, runId), 'not json\n');
    appendSpecReviewEntry(dataDir, runId, { kind: 'review', stepId: 'review-spec', actor: 'agent', verdict: 'pass', report: 'ok' });

    expect(() => readSpecReviewEntries(dataDir, runId)).not.toThrow();
    const entries = readSpecReviewEntries(dataDir, runId);
    expect(entries.map((e) => e.kind)).toEqual(['spec', 'review']);
  });

  it('5b. an unmatched review (no spec entry yet) has NO revision key, and does not consume a revision', () => {
    const unmatched = appendSpecReviewEntry(dataDir, runId, {
      kind: 'review',
      stepId: 'review-spec',
      actor: 'agent',
      verdict: 'revise',
      report: 'no draft was ever captured',
    });
    expect(unmatched.kind).toBe('review');
    expect('revision' in unmatched).toBe(false);
    // Assert on the raw JSON, not just the parsed object, so an undefined-vs-absent slip is caught.
    const rawLine = readRawLines()[0]!;
    expect(JSON.parse(rawLine)).not.toHaveProperty('revision');

    const spec = appendSpecReviewEntry(dataDir, runId, {
      kind: 'spec',
      stepId: 'spec',
      specPath: 'x.md',
      source: 'recorded',
      text: 'v1',
    });
    expect(spec.kind).toBe('spec');
    if (spec.kind !== 'spec') throw new Error('unreachable');
    expect(spec.revision).toBe(1); // the unmatched review did not consume a revision number
  });

  it('5c. revision assignment is derived from the log on disk, not from an in-memory counter, and survives a restart', () => {
    appendSpecReviewEntry(dataDir, runId, { kind: 'spec', stepId: 'spec', specPath: 'x.md', source: 'recorded', text: 'v1' });
    appendSpecReviewEntry(dataDir, runId, { kind: 'review', stepId: 'review-spec', actor: 'agent', verdict: 'revise', report: 'r1' });
    appendSpecReviewEntry(dataDir, runId, { kind: 'spec', stepId: 'spec', specPath: 'x.md', source: 'recorded', text: 'v2' });

    // A "fresh module instance" is simulated by calling the same pure functions again over the
    // same data dir — there is no in-memory state in this module to reset, which is the point.
    const third = appendSpecReviewEntry(dataDir, runId, { kind: 'spec', stepId: 'spec', specPath: 'x.md', source: 'recorded', text: 'v3' });
    expect(third.kind).toBe('spec');
    if (third.kind !== 'spec') throw new Error('unreachable');
    expect(third.revision).toBe(3);

    const reviews = readSpecReviewEntries(dataDir, runId).filter((e) => e.kind === 'review');
    expect(reviews.map((e) => e.revision)).toEqual([1]); // inherits the latest spec's revision, not its own seq
  });

  it('6. readSpecReviewEntries on a run with no file returns []', () => {
    expect(readSpecReviewEntries(dataDir, 'never-existed')).toEqual([]);
  });
});
