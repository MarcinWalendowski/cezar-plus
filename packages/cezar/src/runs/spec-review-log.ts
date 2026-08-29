import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';

/**
 * The spec/review feed's append-only per-run side log (`.ai/specs/2026-08-29-spec-tab-review-
 * feed.md`, work package P1): one JSON line per snapshot/verdict, at
 * `<dataDir>/runs/<runId>.spec-review.ndjson`.
 *
 * Written at the two moments the information exists and nowhere else — never read back and
 * rewritten in place — so revision 1's text survives the `spec` step overwriting the same file on
 * disk for revision 2. See the spec's "Solution" and "Data models" sections for the full argument.
 */

/** Shared envelope. `seq` is per-run and monotonic. `revision` is deliberately NOT here — it is
 *  required on a spec entry (a spec entry IS a revision) and optional on a review entry (a
 *  verdict can arrive with no captured draft to attach it to). See "Revision assignment" below.
 */
const specReviewBaseFields = {
  seq: z.number().int().nonnegative(),
  at: z.string(),
  /** Workflow step that produced it: `spec` / `review-spec` on the built-in chain, but never
   *  assumed to be either: the writer keys on the CEZ:SPEC_PATH declaration, not on the id. */
  stepId: z.string(),
};

export const specReviewSpecEntrySchema = z.looseObject({
  ...specReviewBaseFields,
  kind: z.literal('spec'),
  /** REQUIRED. Counts spec attempts from 1, in capture order. */
  revision: z.number().int().min(1),
  /** As declared by `CEZ:SPEC_PATH=`, capped like `declaredSpecPath`. */
  specPath: z.string().max(500),
  /** `recorded` = snapshotted when that attempt finished. `worktree` = synthesised by the read
   *  route from the live file, for a run written before this feature or still mid-spec. */
  source: z.enum(['recorded', 'worktree']),
  text: z.string().optional(),
  /** Text exceeded SPEC_SNAPSHOT_CAP and was cut at the head (kept from position 0). */
  truncated: z.literal(true).optional(),
  /** The step declared a path that did not resolve, or the containment-safe reader refused it.
   *  `text` is absent whenever this is set. */
  missing: z.literal(true).optional(),
  /** Set alongside `missing` when the reason is specifically that `readWorktreePath` REJECTED the
   *  path (traversal, `.git` internals, a symlink) rather than the file simply not existing. */
  rejected: z.literal(true).optional(),
  /** The reader's own error string, when `missing`/`rejected` is set — never the raw path or file
   *  content, both of which can carry host layout or secrets. */
  error: z.string().optional(),
});

export const specReviewReviewEntrySchema = z.looseObject({
  ...specReviewBaseFields,
  kind: z.literal('review'),
  /** OPTIONAL, and absent means something specific: this verdict arrived with no captured spec
   *  to attach it to (see "Revision assignment"). An unmatched review is NOT revision 1. */
  revision: z.number().int().min(1).optional(),
  /** `agent` = the `review-spec` step's CEZ:REVIEW verdict. `human` = a person requesting
   *  changes at the approval gate. Never conflated: they carry different authority. */
  actor: z.enum(['agent', 'human']),
  verdict: z.enum(['pass', 'revise']),
  report: z.string(),
  truncated: z.literal(true).optional(),
});

export const specReviewEntrySchema = z.discriminatedUnion('kind', [
  specReviewSpecEntrySchema,
  specReviewReviewEntrySchema,
]);
export type SpecReviewSpecEntry = z.infer<typeof specReviewSpecEntrySchema>;
export type SpecReviewReviewEntry = z.infer<typeof specReviewReviewEntrySchema>;
export type SpecReviewEntry = z.infer<typeof specReviewEntrySchema>;

export const specReviewSummarySchema = z.object({
  revisions: z.number().int().min(0),
  reviews: z.number().int().min(0),
  latestVerdict: z.enum(['pass', 'revise']).optional(),
});
export type SpecReviewSummary = z.infer<typeof specReviewSummarySchema>;

/** Per-`spec`-entry cap. Corrected from an earlier `200_000` draft, which rested on a false
 *  premise about the largest spec in this repo — see the spec's "Data models → Caps" section for
 *  the measurement. 1,000,000 is a bound, not a policy. */
export const SPEC_SNAPSHOT_CAP = 1_000_000;

/** Per-review-entry cap. Review reports arrive already capped at `CHECK_OUTPUT_CAP` (`run.ts`),
 *  but the writer re-applies its own cap rather than trusting the caller. Kept equal to that
 *  constant deliberately — duplicated rather than imported, so this module never depends on
 *  `workflows/run.ts` (which imports this module). */
export const REVIEW_REPORT_CAP = 20_000;

/** What a caller supplies for a `spec` entry — `seq`, `at` and `revision` are assigned here. */
export type SpecReviewSpecEntryInput = {
  kind: 'spec';
  stepId: string;
  specPath: string;
  source: 'recorded' | 'worktree';
  text?: string;
  missing?: true;
  rejected?: true;
  error?: string;
};

/** What a caller supplies for a `review` entry — `seq`, `at` and `revision` are assigned here. */
export type SpecReviewReviewEntryInput = {
  kind: 'review';
  stepId: string;
  actor: 'agent' | 'human';
  verdict: 'pass' | 'revise';
  report: string;
};

export type SpecReviewEntryInput = SpecReviewSpecEntryInput | SpecReviewReviewEntryInput;

/** Same location convention as `RunStore`'s private `eventsPath`/`handoffPath` — one file per run,
 *  under `<dataDir>/runs/`. Exported so `RunStore` can delete it on `deleteRun`/prune and expose it
 *  as its own public `specReviewLogPath` method, and so the read route can find it directly. */
export function specReviewLogPath(dataDir: string, runId: string): string {
  return join(dataDir, 'runs', `${runId}.spec-review.ndjson`);
}

/**
 * Tolerant line-by-line parse: a malformed line (a torn append after a crash, a hand-edit during
 * triage) is skipped, never thrown — same stance as `RunStore#readEvents`. Missing file → `[]`.
 */
export function readSpecReviewEntries(dataDir: string, runId: string): SpecReviewEntry[] {
  let raw: string;
  try {
    raw = readFileSync(specReviewLogPath(dataDir, runId), 'utf8');
  } catch {
    return [];
  }
  const out: SpecReviewEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = specReviewEntrySchema.safeParse(json);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function redactIfEnabled(text: string): string {
  if (process.env.CEZ_REDACT_SECRETS === '0') return text;
  return redactSecrets(text, collectSecretValues());
}

/** `(max VALID seq already in the log) + 1`, never `entries.length` — see the module doc comment
 *  on "Revision assignment" in the spec for why the two differ and why it matters. `entries` must
 *  already be the tolerant-parsed (valid-only) list. */
function nextSeq(entries: SpecReviewEntry[]): number {
  let max = -1;
  for (const entry of entries) if (entry.seq > max) max = entry.seq;
  return max + 1;
}

/** `(max revision over existing spec entries) + 1`, i.e. `1` for the first — derived from the
 *  log's own contents at append time, never from an in-memory counter, so a process restart
 *  mid-run cannot restart the numbering. */
function nextRevision(entries: SpecReviewEntry[]): number {
  let max = 0;
  for (const entry of entries) if (entry.kind === 'spec' && entry.revision > max) max = entry.revision;
  return max + 1;
}

/** The revision a `review` entry takes: the LATEST spec entry already in the log, or `undefined`
 *  when the log holds no spec entry at all (an unmatched review — never labelled revision 1). */
function latestSpecRevision(entries: SpecReviewEntry[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.kind === 'spec') return entry.revision;
  }
  return undefined;
}

/**
 * Assigns `seq` and `at`, redacts free text, caps it, and appends one JSON line. `revision` is
 * assigned HERE, never by the caller — see "Revision assignment" in the spec's Data models
 * section for why that invariant has to live in one place.
 */
export function appendSpecReviewEntry(
  dataDir: string,
  runId: string,
  input: SpecReviewEntryInput,
): SpecReviewEntry {
  const existing = readSpecReviewEntries(dataDir, runId);
  const seq = nextSeq(existing);
  const at = new Date().toISOString();

  let entry: SpecReviewEntry;
  if (input.kind === 'spec') {
    const revision = nextRevision(existing);
    let text = input.text !== undefined ? redactIfEnabled(input.text) : undefined;
    let truncated: true | undefined;
    if (text !== undefined && text.length > SPEC_SNAPSHOT_CAP) {
      text = text.slice(0, SPEC_SNAPSHOT_CAP);
      truncated = true;
    }
    entry = {
      seq,
      at,
      stepId: input.stepId,
      kind: 'spec',
      revision,
      specPath: input.specPath.slice(0, 500),
      source: input.source,
      ...(text !== undefined ? { text } : {}),
      ...(truncated ? { truncated } : {}),
      ...(input.missing ? { missing: true as const } : {}),
      ...(input.rejected ? { rejected: true as const } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    };
  } else {
    const revision = latestSpecRevision(existing);
    let report = redactIfEnabled(input.report);
    let truncated: true | undefined;
    if (report.length > REVIEW_REPORT_CAP) {
      report = report.slice(0, REVIEW_REPORT_CAP);
      truncated = true;
    }
    entry = {
      seq,
      at,
      stepId: input.stepId,
      kind: 'review',
      ...(revision !== undefined ? { revision } : {}),
      actor: input.actor,
      verdict: input.verdict,
      report,
      ...(truncated ? { truncated } : {}),
    };
  }

  appendFileSync(specReviewLogPath(dataDir, runId), `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/** `RunRecord.specReview` — computed from the log, never trusted to stay in sync with it (the
 *  read route always recomputes rather than echoing the stored summary; see the spec's "The
 *  summary on RunRecord" point 4). */
export function summariseSpecReview(entries: SpecReviewEntry[]): SpecReviewSummary {
  let revisions = 0;
  let reviews = 0;
  let latestVerdict: 'pass' | 'revise' | undefined;
  for (const entry of entries) {
    if (entry.kind === 'spec') {
      if (entry.revision > revisions) revisions = entry.revision;
    } else {
      reviews += 1;
      latestVerdict = entry.verdict;
    }
  }
  return { revisions, reviews, ...(latestVerdict !== undefined ? { latestVerdict } : {}) };
}
