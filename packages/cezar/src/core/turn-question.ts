/**
 * Detects a trailing question in a turn that ended with NO marker at all (spec
 * 2026-08-23-plain-end-structured-question). Pure, total, no I/O — a sibling of
 * `ask.ts`, but it never mints an ask card: its only outputs are (a) whether to
 * spend a nudge and (b) the agent's own trailing sentence, verbatim and clipped.
 * It never synthesises a question, never invents options, and never converts
 * prose into an `ask.requested` event — see the spec's D2.
 */

/** The last non-empty paragraph a plain turn end is scanned within. A question
 *  to the user lives at the end of a turn; scanning the whole transcript would
 *  let a mid-report rhetorical `?` decide the outcome. */
export const QUESTION_SCAN_TAIL_CHARS = 1200;

/** Matches the ask schema's own `description` bound (`ask.ts`) — this string
 *  renders in the dock, not in a notification body (`ASK_TEXT_MAX_CHARS` in
 *  `notifications/observer.ts` is the wider bound for that). */
export const TRAILING_QUESTION_MAX_CHARS = 280;

const FENCE_RE = /```[\s\S]*?```/g;
/** Trailing protocol lines are noise, not the question — and `CEZ:TITLE=` in
 *  particular already caused a marker-absorption bug once (#623). */
const PROTOCOL_LINE_RE = /^\s*CEZ:[A-Z_]+.*$/gm;

/** A small, closed, second-person list. Deliberately tight: bare `confirm`
 *  matches "I'll confirm the deploy" and is excluded on purpose. */
const DECISION_CUE_RE =
  /\b(let me know|do you want|would you like|should i|shall i|your call|please confirm|can you confirm|waiting (on|for) (you|your)|tell me which|which (do|would) you)\b/i;

export interface TrailingQuestion {
  /** The agent's own sentence, verbatim and clipped. Never synthesised. */
  text: string;
}

function clip(text: string): string {
  if (text.length <= TRAILING_QUESTION_MAX_CHARS) return text;
  return `${text.slice(0, TRAILING_QUESTION_MAX_CHARS - 1)}…`;
}

/**
 * Classifies a plain (unmarked) turn end as addressed to the user (`question`,
 * non-null) or not (`report`, `null`). Called ONLY when the turn ended with no
 * `CEZ:DONE` / `CEZ:ASK` / `CEZ:MONITORING` — see `run.ts`'s twin turn-end
 * sites, which compute this before `turnText` is reset for the next turn.
 */
export function detectTrailingQuestion(turnText: string): TrailingQuestion | null {
  if (!turnText) return null;
  const stripped = turnText.replace(FENCE_RE, ' ').replace(PROTOCOL_LINE_RE, '');
  const trimmed = stripped.trim();
  if (!trimmed) return null;

  const paragraphs = trimmed.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const lastParagraph = paragraphs[paragraphs.length - 1] ?? '';
  const tail =
    lastParagraph.length > QUESTION_SCAN_TAIL_CHARS
      ? lastParagraph.slice(-QUESTION_SCAN_TAIL_CHARS)
      : lastParagraph;
  const tailTrimmed = tail.trim();
  if (!tailTrimmed) return null;

  const sentences = tailTrimmed
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sentences.length) return null;

  for (let i = sentences.length - 1; i >= 0; i--) {
    const sentence = sentences[i];
    if (sentence !== undefined && /\?\s*$/.test(sentence)) return { text: clip(sentence) };
  }
  for (let i = sentences.length - 1; i >= 0; i--) {
    const sentence = sentences[i];
    if (sentence !== undefined && DECISION_CUE_RE.test(sentence)) return { text: clip(sentence) };
  }
  return null;
}
