import { createReadStream } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { RunEvent } from '@loki-labs/cezar-plus-contract';

/**
 * Tool-economy metrics for a run, derived from its NDJSON transcript
 * (spec `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`, Phase 1;
 * re-based on the v2 item stream by `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md`,
 * Phases 1-2).
 *
 * **This module is the METER, and it ships before the optimisations it exists to judge.** The
 * repo's own standing rule is that decisions come from measured numbers; without this, every
 * later phase of that spec is an assertion. Nothing here changes agent behaviour.
 *
 * Everything is computed on demand from the NDJSON and **nothing is persisted** — no field is
 * added to `runs.json`, so `runs/store.ts` and the contract-parity tests do not move. The event
 * log is an append-only on-disk format (`BACKWARD_COMPATIBILITY.md` §7), which is exactly what
 * makes it safe to replay an old recording with new arithmetic.
 *
 * **Two things this meter got wrong for its first two days, and how they are fixed here.**
 *
 * 1. It counted a sub-agent dispatch by exact string equality with `'Task'`. Claude emits
 *    `'Agent'`; `"tool":"Task"` occurs zero times in every transcript on this box. Three separate
 *    runs dispatched three sub-agents each and every one of them was recorded as zero. The count
 *    now comes from the v2 item stream's `toolKind` (`core/tool-display.ts:144-155` normalises
 *    `Task` / `Agent` / opencode's `task` to the same kind), so it is spelling-proof and
 *    backend-agnostic — minus the `Skill` case, which `tool-display.ts:159-165` maps to that same
 *    `toolKind: 'task'` for display grouping and which is NOT fan-out.
 * 2. It billed a CHILD's tool calls to the PARENT's step, because `core/claude-cli-runner.ts`
 *    emits a v1 `tool-call` for every `tool_use` block with no parent filter and
 *    `workflows/run.ts` stamps `stepId` on all of them. On one measured run, 93 of a step's 106
 *    metered calls were made by sub-agents inside their own windows; the parent spent 13. So
 *    fan-out used to RAISE the round-trip count it was supposed to lower.
 *
 * Both fixes read events that were **already on disk** — no protocol widening, no change to any
 * runner. The join that makes it work: the v1 `tool-call.id` and the v2 `item.id` are the same
 * `toolu_…` string (measured: zero unmatched across four transcripts).
 *
 * **`sleepCalls` / `blindSleepCalls` / `sleepExecMs` / `repeatedExpensiveCalls` were added on
 * 2026-08-21** (spec `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md`) and are the first
 * counters here that read a tool call's `input`. They exist so the two claims that spec makes are
 * falsifiable rather than asserted: that agents stopped guessing a duration, and that they stopped
 * re-running an expensive command to see a different slice of its output. Replayed against the
 * transcripts on the production box, they reproduce that spec's Problem table exactly —
 * `7c2dd8f0` → sleep 18, blind 4, 13.4 min, re-run 18.
 */

/** A tool call shorter than this counts as "cheap": it did no real work, it only cost a turn. */
const CHEAP_CALL_MS = 1_000;

/**
 * Gaps longer than this are not the model thinking — they are a step parked at `waiting`, a
 * queued run, or a restart. Counting them as model time would make an idle overnight run look
 * like the slowest reasoning in history.
 */
const MAX_MODEL_GAP_MS = 600_000;

/** Key used for tool calls that carry no `stepId` (none do today; a malformed log could). */
const NO_STEP = '(no step)';

/**
 * Fallback dispatch spellings, used ONLY for a call with no v2 item to read.
 *
 * Case-insensitive, and deliberately wider than the old `=== 'Task'`: claude says `Agent`,
 * opencode says `task`, older recordings say `Task`. This is what keeps a pre-v2 transcript
 * answering the question it was asked instead of silently reporting zero.
 */
const FALLBACK_DISPATCH_NAMES = new Set(['task', 'agent']);

/**
 * A first invocation slower than this is "expensive": re-running it only to see a different slice
 * of the same output is measurable waste. The floor keeps `git status` and friends out of it.
 */
const EXPENSIVE_CALL_MS = 5_000;

/**
 * An early-exit guard. A poll loop that sleeps between probes and breaks when the job finishes is
 * the CORRECT pattern — 32 of the 39 sleeps measured across five runs — so the defect counter has
 * to be able to tell it apart from a guessed duration.
 */
const SLEEP_GUARD = /\b(until|while|for)\b/;

/** `sleep <n>`, capturing the duration so `sleep 0` (which waits for nothing) can be dropped. */
const SLEEP_N = /\bsleep\s+([\d.]+)/g;

/**
 * The expensive verbs of this repo's toolchain. An allowlist, deliberately: it under-reports on a
 * stack that invokes its tests some other way rather than inventing hits on an unknown one.
 */
const COSTLY_INVOCATION =
  /(^|[;&|(\s])(npx\s+vitest|npx\s+tsc|vitest\s+run|npm\s+(run\s+\S+|test|ci|install)|pnpm\s+\S+|tools\/(typecheck|lint|test))\b/;

/**
 * Drop heredoc BODIES before reading a command.
 *
 * Measured necessity, in both directions. A `sleep 25` being *written into a script file* waits
 * for nothing, and counting it over-reports (`7c2dd8f0` wrote a timing experiment that way). But
 * stripping alone is net-zero: English prose inside a python heredoc ("…for the Wave A gate") was
 * acting as the `for` guard on a different call, so removing it correctly exposed a `sleep 0` that
 * is not a wait either. Stripping AND requiring a positive duration is what lands on the 7 genuine
 * blind waits; either one alone finds 8, and not the same 8.
 *
 * Only the closing tag alone on its own line ends a body, which is also how the shell reads it.
 */
function stripHeredocs(command: string): string {
  const kept: string[] = [];
  let terminator: string | null = null;
  for (const line of command.split('\n')) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    kept.push(line);
    const opened = line.match(/<<-?\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))\s*$/);
    if (opened) terminator = opened[1] ?? opened[2] ?? opened[3] ?? null;
  }
  return kept.join('\n');
}

/** What a Bash command tells us about waiting and about repetition. */
interface CommandSignals {
  isSleep: boolean;
  isBlindSleep: boolean;
  /** The costly invocation lines with their output filters removed, or '' if the call is cheap. */
  expensiveKey: string;
}

/**
 * **Both predicates are crude on purpose, and their failure directions are documented rather than
 * hidden** (spec `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` § Data models):
 *
 * - False "guarded": `for f in a b c; do …; done; sleep 60` — an unrelated loop and a blind sleep
 *   in one batch. This one UNDER-reports, so read the command list, not only the count.
 * - False "blind": a sleep bounded by `timeout` or a `trap`. Over-reports; errs toward flagging.
 * - Neither can separate overshoot from the real duration of the job waited for. Nothing in the
 *   NDJSON can.
 */
function signalsOf(command: string): CommandSignals {
  const text = stripHeredocs(command);
  const isSleep = [...text.matchAll(SLEEP_N)].some((m) => Number.parseFloat(m[1] ?? '0') > 0);
  const costly = text
    .split('\n')
    .filter((line) => COSTLY_INVOCATION.test(line))
    // The defect is the SAME command with a DIFFERENT filter, so the filter is what the key drops.
    // An exact-string key measures zero on every real run — that is how rev 1 of the spec would
    // have shipped a permanently-zero metric.
    .map((line) => (line.split(/[|>]/)[0] ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return {
    isSleep,
    isBlindSleep: isSleep && !SLEEP_GUARD.test(text),
    expensiveKey: costly.join(' ; '),
  };
}

function commandOf(event: RunEvent): string {
  const input = (event as { input?: unknown }).input;
  if (typeof input !== 'object' || input === null) return '';
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : '';
}

/**
 * The file-authoring heredoc predicate (spec
 * `.ai/specs/2026-08-21-edit-an-existing-file-never-re-emit-it.md` § Data models, "exactly").
 *
 * `OPENS_HEREDOC` is deliberately looser than `stripHeredocs()`'s own end-of-line opener regex: it
 * has to match `cat <<'EOF' > P`, where the tag is not at end of line because a redirect trails it.
 * `stripHeredocs()` itself is NOT touched — see `heredocChars` below for why.
 */
const OPENS_HEREDOC = /<<-?\s*['"]?[A-Za-z_]\w*['"]?/;
/** `cat … > P` / `cat … >> P` — either ordering, `cat > P <<T` and `cat <<T > P`. */
const CAT_TARGET = /(?:^|[;&|]\s*)cat\b[^|\n]*?>{1,2}\s*['"]?([^\s'";|&<>]+)/;
/** `tee P` / `tee -a P` — POSITIONAL, no redirect. A `>`-only regex can never match this. */
const TEE_TARGET = /(?:^|[;&|]\s*)tee\b\s+(?:-a\s+)?['"]?([^\s'";|&<>][^\s'";|&<>]*)/;
/** Captures the heredoc TERMINATOR, wherever `<<TAG` sits on the line — needed to find where the
 *  body ends, which `OPENS_HEREDOC` alone (a presence test) does not give us. */
const HEREDOC_TAG = /<<-?\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/;

interface HeredocEntry {
  /** The line that opened this heredoc — tested against `CAT_TARGET` / `TEE_TARGET`. */
  openerLine: string;
  body: string[];
}

/**
 * Every heredoc in a command, paired with the line that opened it.
 *
 * Its own walk, not reused from `stripHeredocs()` — see `OPENS_HEREDOC`'s comment. A line is only
 * ever tested for a NEW opener while no body is currently open, so a heredoc BODY that itself
 * contains `<<` (a script writing a heredoc-parsing script, a JS template literal) can never be
 * mistaken for a second opener — it is already inside `body` by the time this walk would see it.
 */
function heredocEntriesOf(command: string): HeredocEntry[] {
  const lines = command.split('\n');
  const entries: HeredocEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!OPENS_HEREDOC.test(line)) {
      i += 1;
      continue;
    }
    const tagMatch = HEREDOC_TAG.exec(line);
    const tag = tagMatch ? (tagMatch[1] ?? tagMatch[2] ?? tagMatch[3] ?? undefined) : undefined;
    if (tag === undefined) {
      i += 1;
      continue;
    }
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? '').trim() !== tag) {
      body.push(lines[j] ?? '');
      j += 1;
    }
    entries.push({ openerLine: line, body });
    i = j + 1;
  }
  return entries;
}

/** The path a file-authoring heredoc's opener line targets, or `undefined` if this heredoc's body
 *  is a SCRIPT rather than a file's content (e.g. `python3 - <<'PY' > out.txt` — `out.txt` is the
 *  script's stdout, not the heredoc's body). */
function authoredPathOf(openerLine: string): string | undefined {
  const cat = CAT_TARGET.exec(openerLine);
  if (cat?.[1]) return cat[1];
  const tee = TEE_TARGET.exec(openerLine);
  if (tee?.[1]) return tee[1];
  return undefined;
}

/**
 * Paths this command READ, as far as this predicate can tell — `cat`/`head`/`tail` (whole command,
 * heredoc bodies stripped first so a script's own `cat` calls inside a heredoc body do not count)
 * or `sed -n … …p`. Feeds `seenPaths` only, never a gate on its own — see `heredocRewrites`' doc
 * comment for the failure directions this inherits.
 */
function readTargetsOf(command: string): string[] {
  const text = stripHeredocs(command);
  const targets: string[] = [];
  const CAT_READ = /(?:^|[;&|]\s*)(?:cat|head|tail)\b\s+(?:-\S+\s+)*['"]?([^\s'";|&<>-][^\s'";|&<>]*)/g;
  for (const m of text.matchAll(CAT_READ)) if (m[1]) targets.push(m[1]);
  const SED_READ = /(?:^|[;&|]\s*)sed\s+-n\s+(?:'[^']*'|"[^"]*"|\S+)\s+['"]?([^\s'";|&<>][^\s'";|&<>]*)/g;
  for (const m of text.matchAll(SED_READ)) if (m[1]) targets.push(m[1]);
  return targets;
}

/** Bounds the LCS DP below — past this many cells it falls back to "no further match" for the
 *  unbounded middle chunk rather than growing without limit (an under-report, same direction as
 *  every other unknown in this module). ~2000×2000, far past any real spec-sized document. */
const LCS_CELL_CAP = 4_000_000;

/** Plain LCS over lines, summing the matched lines' characters (+1 per line for the newline each
 *  carried) — only ever called on the bounded middle chunk `unchangedLineCharsOf` leaves after
 *  trimming the common prefix/suffix. */
function lcsCharsOf(a: readonly string[], b: readonly string[]): number {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  let chars = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      chars += (b[j]?.length ?? 0) + 1;
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return chars;
}

/**
 * Characters of `newLines` that are UNCHANGED from `oldLines` — an LCS over lines, mirroring
 * `difflib.SequenceMatcher`'s "equal" opcodes (spec § Data models, `heredocRewriteWasteChars`).
 * Trims the common prefix/suffix first — O(n), and enough on its own for the two extremes this
 * metric has to tell apart (a byte-identical re-emission, an all-new body) — then runs the O(n·m)
 * LCS only on what is left, bounded by `LCS_CELL_CAP`.
 */
function unchangedLineCharsOf(oldLines: readonly string[], newLines: readonly string[]): number {
  let start = 0;
  const maxStart = Math.min(oldLines.length, newLines.length);
  while (start < maxStart && oldLines[start] === newLines[start]) start += 1;

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const lineChars = (line: string | undefined): number => (line?.length ?? 0) + 1;
  let unchanged = 0;
  for (let i = 0; i < start; i += 1) unchanged += lineChars(newLines[i]);
  for (let i = newEnd; i < newLines.length; i += 1) unchanged += lineChars(newLines[i]);

  const midOld = oldLines.slice(start, oldEnd);
  const midNew = newLines.slice(start, newEnd);
  if (midOld.length > 0 && midNew.length > 0 && midOld.length * midNew.length <= LCS_CELL_CAP) {
    unchanged += lcsCharsOf(midOld, midNew);
  }
  return unchanged;
}

/** Retain at most the last body written to a path, capped — so a pathological run cannot make this
 *  meter's own memory the problem (spec § Data models, `heredocRewriteWasteChars`). */
const MAX_RETAINED_BODY_BYTES = 256 * 1024;

/** Per-step tool-economy metrics, derived from a run's NDJSON. */
export interface StepStats {
  stepId: string;
  /**
   * First `step-start` → last `step-end`.
   *
   * **A restarted step has more than one start** — take the first and the last, never a keyed
   * overwrite. Run `ec6e8e06`'s `spec` step emitted `step-start` twice (13:22:03 and 13:28:12)
   * when its worktree was deleted under it; keying by `stepId` reports that step as 134 s instead
   * of its real 503 s, which is a 4× understatement of the single slowest step in the run. The
   * fixture test pins exactly this.
   */
  wallMs: number;
  /** Extra `step-start` events beyond the first. 0 for a step that ran once. */
  restarts: number;
  /**
   * UNCHANGED MEANING: every tool call stamped with this step — the parent's and its sub-agents'
   * alike. `ownToolCalls + childToolCalls`.
   */
  toolCalls: number;
  /**
   * Calls a sub-agent made inside its OWN context window (its v2 item carried `parentItemId`).
   *
   * Secondary metric: how much exploration the children absorbed on the parent's behalf. It is 0
   * for any transcript with no v2 `item.*` events, which is the correct degradation — an old log
   * cannot tell us who made a call, and guessing would be worse than saying nothing.
   */
  childToolCalls: number;
  /** `toolCalls - childToolCalls`. What THIS step's own agent actually spent in round trips. */
  ownToolCalls: number;
  /**
   * Assistant turns that issued ≥1 **own** tool call — see {@link computeRunStats} for how
   * they're counted. Children no longer split the parent's batch.
   */
  roundTrips: number;
  /** `ownToolCalls / roundTrips`, 2dp. **1.00 means no batching happened at all.** 0 when idle. */
  batchFactor: number;
  /**
   * Highest `context.updated.contextTokens` seen in this step — the parent agent's window only,
   * by construction: `core/claude-ui-mapper.ts` returns no main-agent token count for a subagent
   * frame, so a child's window never appears here.
   *
   * **`undefined`, never 0, when the step emitted no sample** — and that is a real case, not a
   * defensive one: run `7c2dd8f0`'s `spec` step has zero `context.updated` events while its later
   * steps have 72–294. Printing `0` there would read as "this step used no context", which is a
   * lie of exactly the kind this meter exists to remove.
   *
   * Each step is its own agent session with its own window, so peaks are PER-WINDOW and do not
   * compose: `RunStats.totals` takes the max across steps, never the sum.
   */
  peakContextTokens?: number;
  /**
   * Sub-agent DISPATCHES made by this step's own agent — v2 tool items with `toolKind === 'task'`
   * whose tool name is not `Skill` (see the module doc). 0 means the step never delegated.
   *
   * Attributed to the step on the **matching v1 `tool-call` event**, i.e. to the dispatching
   * parent. A nested dispatch made *by* a sub-agent is a child call and is never billed here.
   */
  subAgentCalls: number;
  /**
   * Σ(`tool-result`.ts − `tool-call`.ts) over this step's OWN calls.
   *
   * **This SUMS per-call durations**, so a step that dispatches three sub-agents in one turn
   * triple-counts that wall time. Pre-existing and not fixed here — but do not read it as elapsed
   * time on a fanned-out step. `wallMs` is the elapsed figure.
   */
  toolExecMs: number;
  /** Σ gaps `tool-result` → next `tool-call` in the same step, clamped to `[0, MAX_MODEL_GAP_MS)`.
   *  Own calls only: a child's result never opens or closes one of the parent's gaps. */
  modelMs: number;
  /** Own calls finishing in under a second… */
  cheapCalls: number;
  /** …and the work they actually did. A large `cheapCalls` against a tiny `cheapExecMs` is the
   *  round-trip tax the spec is about. */
  cheapExecMs: number;
  /**
   * Bash calls whose command contains a real `sleep <n>`.
   *
   * **NOT a defect count.** A bounded poll loop legitimately sleeps between probes and exits when
   * the job does; its wall clock is mostly the job. This number may stay non-zero forever.
   */
  sleepCalls: number;
  /**
   * …of which the command carries NO early-exit guard — a guessed duration.
   *
   * **This is the defect.** Target: 0. `sleep 120; tail -12 /tmp/full-suite-mine.log` is the
   * archetype: the agent started something, did not know when it would finish, and guessed.
   */
  blindSleepCalls: number;
  /**
   * Σ exec ms of the `sleepCalls` **that have a matched `tool-result`** — necessarily a smaller
   * set than `sleepCalls`, because exec time needs both events and a wait that never returned has
   * only one. (On `7c2dd8f0`, 16 of 18.) Read it as an upper bound on waiting, not as waste.
   */
  sleepExecMs: number;
  /**
   * Repeat invocations of an expensive command (first run ≥ 5 s) — calls that re-ran work already
   * done, typically only to see a different slice of the same output.
   *
   * **A read-the-list signal, not a gate.** It cannot tell a wasteful re-slice from a legitimate
   * re-run after an edit, and says so rather than pretending to.
   */
  repeatedExpensiveCalls: number;
  /**
   * Where this step's output tokens went, reconciled against `turn.completed.usage.output`
   * (`.ai/specs/2026-08-21-output-token-attribution.md`, Phase 2).
   *
   * **`undefined`, never a fake-zero object** — same convention as `peakContextTokens` — for a
   * step that emitted no `turn.completed` at all (a cancelled step) OR when the caller of
   * {@link computeRunStats} supplied no `tokenize` function (the default: computing this is
   * opt-in, see {@link Tokenize}'s doc comment).
   */
  tokenBreakdown?: TokenBreakdown;
  /**
   * Σ `JSON.stringify(input).length` over EVERY tool call attributed to this step, sub-agent calls
   * INCLUDED — the size of what was emitted to drive tools, as opposed to how many times
   * (`toolCalls`) or how long the tools took (`toolExecMs`).
   *
   * SCOPE: the same scope as `toolCalls`, which also counts children (accumulated before the
   * `childIds` break below) — a sub-agent's characters are still the run's characters. `ownToolCalls`
   * already exists for the other reading; no `ownToolInputChars` is added.
   *
   * SERIALIZATION IS LOAD-BEARING (spec R9): `JSON.stringify`, not Python `json.dumps` — the two
   * disagree on separators and on `\uXXXX`-escaping non-ASCII. A test pins the exact encoding.
   */
  toolInputChars: number;
  /**
   * …of which lives inside a heredoc BODY, measured as the `stripHeredocs()` delta.
   *
   * This is a FLOOR, deliberately. `stripHeredocs()` only recognises an opener whose tag ends the
   * line, so `python3 - <<'PY' > /tmp/out.txt` is invisible to it. **DO NOT WIDEN `stripHeredocs()`
   * to close that gap** — it also feeds `signalsOf()`, i.e. the `sleepCalls` / `blindSleepCalls` /
   * `repeatedExpensiveCalls` metrics, whose own doc comment records exactly what widening it would
   * re-score. Reuse it unchanged; the under-count is accepted (spec § Data models).
   */
  heredocChars: number;
  /**
   * Heredocs whose BODY IS A FILE'S CONTENT — `cat > P <<T`, `cat >> P <<T`, `cat <<T > P`,
   * `tee P <<T`, `tee -a P <<T`. Counted per heredoc, not per call: one call may author two files.
   *
   * Deliberately narrower than "contains a heredoc": in `python3 - <<'PY' > out.txt` the body is a
   * SCRIPT and `out.txt` is its stdout, not the heredoc's content — a script that transforms twelve
   * files is the correct tool and must not score here. `/tmp` scratch scripts DO count: a throwaway
   * script re-emitted is still re-emitted.
   */
  heredocFileWrites: number;
  /**
   * …of which target a path this run has ALREADY written or read, EARLIER IN THE SAME RUN — either
   * (a) the target of another file-authoring heredoc, or (b) read (a `Read` tool call's
   * `file_path`, or a `cat`/`head`/`tail`/`sed -n …p` argument in a Bash command).
   *
   * **This is a DIAGNOSTIC, not the gate** — see `heredocRewriteWasteChars`. A count cannot tell a
   * wasteful re-emission from a legitimate near-total rewrite; both failure directions of the
   * predicate are accepted rather than hidden (spec § Data models): it UNDER-reports a file that
   * existed before the run and was never read first, and it OVER-reports a legitimate full
   * regeneration that was also read.
   */
  heredocRewrites: number;
  /**
   * **THE DEFECT, IN CHARACTERS, AND THE ONLY HARD GATE.** For each re-emission, the number of
   * characters of the new body that are UNCHANGED from the body this run last wrote to that path —
   * i.e. what was paid for twice and bought nothing. Σ over the step.
   *
   * Why this and not `heredocRewrites`: a count punishes the legitimate case — a near-total rewrite
   * carries almost no unchanged lines and scores ≈ 0 here by construction, where a count would flag
   * it identically to a byte-identical re-emission.
   */
  heredocRewriteWasteChars: number;
}

/** Which data a step's {@link TokenBreakdown} was computed from. */
export type TokenBreakdownMode = 'calibrated' | 'basic' | 'unavailable';

/**
 * A replay-time RECONSTRUCTION of one step's output-token composition — not a wire-reported
 * figure. No backend, claude included, reports a per-category token count; `usage.output` is one
 * number covering every content-block type in the turn together (spec Solution section).
 *
 * **Three categories, three different epistemic statuses, not one number:**
 * - `narrationTokens` / `toolArgTokens` / `thinkingTokens` are MEASURED — real BPE tokenization
 *   of text cezar's own NDJSON already persists in full.
 * - `withheldThinkingTokens` is INFERRED — a calibration-ratio subtraction over content Anthropic
 *   never reveals (blank `thinking` blocks), never a measured count.
 * - `unclassifiedGapTokens` (basic mode) is UNATTRIBUTED — a residual reported honestly as one
 *   labeled line, with no attempt to split it further without the transcript's classification.
 *
 * `mode` says which of these are available. Every `*Tokens` field is tokenized with whatever
 * {@link Tokenize} function the caller passed to {@link computeRunStats} — real, deterministic,
 * reproducible, but an APPROXIMATION of the backend's own (undisclosed) tokenizer (spec Risk R1).
 */
export interface TokenBreakdown {
  mode: TokenBreakdownMode;
  /** Σ `turn.completed.usage.output` over this step's turns — the ground truth being reconciled.
   *  MAIN-AGENT-ONLY: a dispatched sub-agent's turns are billed to its own `turn.completed` under
   *  its own `sessionId`, never rolled into this one — every field below is filtered to match
   *  (excludes any item with a `parentItemId`). Required in EVERY mode, including `'unavailable'`
   *  — a defined `TokenBreakdown` always has a usage total, even when nothing downstream of it
   *  could be measured (`StepStats.tokenBreakdown` itself is `undefined` when there is none). */
  reportedTokens: number;
  /** Tokenized text of every non-child `'message'` `item.completed` (`item.parentItemId`
   *  absent — read directly, NOT via `ItemIndex.childIds`, which only indexes `kind === 'tool'`
   *  items). `undefined` only in `'unavailable'` mode. */
  narrationTokens?: number;
  /** Tokenized `JSON.stringify(item.input)` of every non-child `'tool'` `item.completed`/
   *  `item.started` (deduped by item id, `item.completed`'s input preferred). Filtered via
   *  `ItemIndex.childIds` (`indexToolItems`). `undefined` only in `'unavailable'` mode. */
  toolArgTokens?: number;
  /** The same tokenization, but for tool items that DO carry a `parentItemId` — ran inside a
   *  sub-agent's own context window. Real spend, but never counted in `reportedTokens`, so it is
   *  reported here as its own explicitly-unbilled-to-this-step line, never folded into
   *  `toolArgTokens`/`measuredTokens`. `0` for a step that dispatched nothing; `undefined` only
   *  in `'unavailable'` mode — "dispatched nothing" and "couldn't be measured" stay distinguishable. */
  childToolArgTokens?: number;
  /** Tokenized text of every non-child `'reasoning'` `item.completed` — the mapper only mints
   *  these for NON-BLANK `thinking` text, so this is genuinely MEASURED, never inferred. Zero on
   *  a step whose model withholds thinking (opus/sonnet); real and nonzero on a step using a
   *  model that emits visible thinking (haiku). Included in `measuredTokens`. `undefined` only
   *  in `'unavailable'` mode. */
  thinkingTokens?: number;
  /** `narrationTokens + toolArgTokens + thinkingTokens` — RAW `gpt-tokenizer` counts, kept as a
   *  diagnostic (D6, this revision). Deliberately excludes `childToolArgTokens` (unbilled to this
   *  step) and `withheldThinkingTokens`/`unclassifiedGapTokens` (inferences, not measurements —
   *  folding either in here would make "components sum to `reportedTokens`" true by construction,
   *  the tautology criterion 3 is built to rule out). `undefined` only in `'unavailable'` mode.
   *  In `'calibrated'` mode this is NOT the headline figure — see `calibratedMeasuredTokens`
   *  below: this run's own regression shows the raw tokenizer count undercounts real billed
   *  tokens by a wide, consistent margin (see `freeGapPct`), so printing this beside
   *  `withheldThinkingTokens` (which IS scaled to the billed count) puts two different scales in
   *  one table — the defect D6 fixes. */
  measuredTokens?: number;
  /** `'calibrated'` mode only, NEW this revision (D6): `narrationTokens × tokenScaleFactor` —
   *  puts narration on the same billed-token scale as `reportedTokens`/`withheldThinkingTokens`,
   *  unlike the raw `narrationTokens` above. `tokenScaleFactor` (the run-wide `freeTokens /
   *  freeTokenized` ratio — see `calibration.appliedScaleFactor`) is applied, NOT
   *  `calibration.appliedRatio` (the chars/token diagnostic, retained but no longer applied to
   *  anything). `undefined` outside `'calibrated'` mode, or when `tokenScaleFactor` itself is
   *  `undefined` (the zero-free-response guard, N4). */
  calibratedNarrationTokens?: number;
  /** `'calibrated'` mode only, NEW this revision (D6): `toolArgTokens × tokenScaleFactor`. Same
   *  scaling as `calibratedNarrationTokens`, applied to tool-call-argument tokens — the category
   *  the as-shipped (pre-D6) design most understated (raw ~36.8% of `reportedTokens` on
   *  `70f19253`, ~57.8% once consistently calibrated — the single largest category in the run).
   *  `undefined` outside `'calibrated'` mode, or when `tokenScaleFactor` is `undefined`. */
  calibratedToolArgTokens?: number;
  /** `'calibrated'` mode only, NEW this revision (D6): `thinkingTokens × tokenScaleFactor`. Zero
   *  on a step whose model withholds thinking (`thinkingTokens` itself is 0 there); real and
   *  nonzero on a step using a model that emits visible thinking (e.g. `claude-haiku-4-5`).
   *  `undefined` outside `'calibrated'` mode, or when `tokenScaleFactor` is `undefined`. */
  calibratedThinkingTokens?: number;
  /** `'calibrated'` mode only, NEW this revision (D6): `calibratedNarrationTokens +
   *  calibratedToolArgTokens + calibratedThinkingTokens`. This — not the raw `measuredTokens`
   *  above — is the figure `calibratedResidual` is computed against, and the one `formatRunStats`
   *  leads with in calibrated mode. `undefined` outside `'calibrated'` mode, or when
   *  `tokenScaleFactor` is `undefined`. */
  calibratedMeasuredTokens?: number;
  /** `'calibrated'` mode only: `bearingTokens − (bearingVisibleTokenized × tokenScaleFactor)` —
   *  the thinking-bearing subset's ground-truth usage minus its predicted visible-token cost,
   *  where `bearingVisibleTokenized` is the REAL tokenization (not a chars/ratio estimate,
   *  corrected this revision, D6) of each bearing response's `visibleText` — narration text,
   *  tool-arg JSON, and any recorded NON-BLANK thinking text, so a response whose thinking was
   *  actually visible doesn't get double-counted as both measured (via `thinkingTokens`) and
   *  withheld here. `tokenScaleFactor` is RUN-WIDE (pooled across every step's thinking-free
   *  responses before the per-step computation, never this step's own — a thin per-step sample is
   *  unstable). SIGNED. An INFERENCE, labeled as such in every consumer — never confused with
   *  `thinkingTokens`, which is measured. `undefined` outside `'calibrated'` mode, and within it,
   *  whenever the RUN has zero thinking-free responses anywhere (no `tokenScaleFactor` is
   *  computable — that run's steps report `mode: 'basic'` instead, never `NaN`). Collapses toward
   *  (not `undefined`, just small) `0` on a step where thinking was fully visible. */
  withheldThinkingTokens?: number;
  /** `'calibrated'` mode only: `reportedTokens − (calibratedMeasuredTokens +
   *  withheldThinkingTokens)`. SIGNED.
   *  **Corrected this revision (D7) — this is an EXACT ALGEBRAIC IDENTITY at the RUN level, not a
   *  measurement-quality residual.** Substituting the definitions: `calibratedMeasuredTokens +
   *  withheldThinkingTokens` telescopes to `(tokenScaleFactor × freeTokenized) + bearingTokens`,
   *  and `tokenScaleFactor` is *defined* as `freeTokens / freeTokenized` — so that first term is
   *  exactly `freeTokens`, for any tokenizer accuracy whatsoever, and the run-level sum is exactly
   *  `freeTokens + bearingTokens = reportedTokens`. So this field sums to ~0 across a run's steps
   *  BY CONSTRUCTION (measured: 3 tokens over 375,001 = 0.0008% on `70f19253`) — it CANNOT fail
   *  for a measurement reason, so no test asserts a tolerance on it (Phase 4's `HOLDOUT_TOLERANCE`
   *  hold-out prediction of `tokenScaleFactor` itself is the real falsifiable criterion-3 test —
   *  see Verification §4). At the PER-STEP level the identity does not close exactly — it reduces
   *  to that step's own `freeTokens_step − tokenScaleFactor × freeTokenized_step`, a real,
   *  printable diagnostic of how well the run-wide pooled `tokenScaleFactor` fits THIS step's own
   *  free-response mix (measured band on `70f19253`: −0.40% to +0.15% of that step's
   *  `reportedTokens`) — still worth reporting as a per-step calibration-homogeneity check, just
   *  not a reconciliation test. `undefined` outside `'calibrated'` mode, or when `tokenScaleFactor`
   *  is `undefined`. */
  calibratedResidual?: number;
  /** `'basic'` mode only: `reportedTokens − measuredTokens`, reported as ONE unattributed line —
   *  no attempt to split it into thinking vs tokenizer noise without the transcript's
   *  per-response classification. `undefined` in `'calibrated'`/`'unavailable'` mode. */
  unclassifiedGapTokens?: number;
  /** `'calibrated'` mode only: the gap on THIS STEP's own thinking-free response subset alone —
   *  `(freeTokens − Σ tokenize(text/tool-args of those free responses)) / freeTokens × 100`, 1dp.
   *  **Role corrected this revision (D6) — this is `tokenScaleFactor`'s own fit-quality
   *  diagnostic, NOT a measure of unattributable spend.** Regressing billed tokens against
   *  tokenized visible content over a run's own free responses shows the gap this field measures
   *  is ~91% proportional to the tokenized content — exactly what `tokenScaleFactor` exists to
   *  absorb, not overhead sitting outside `narrationTokens`/`toolArgTokens`. A large, stable
   *  `freeGapPct` is expected and fine: it is exactly why a *scale* factor, not a small additive
   *  correction, is the right shape of fix. The real falsifiable criterion-3 test is Phase 4's
   *  `HOLDOUT_TOLERANCE` hold-out prediction of `tokenScaleFactor` (Verification §4), not a
   *  tolerance asserted on this field directly. `undefined` outside `'calibrated'` mode, or when
   *  this step's own local free-response count is zero (nothing to compute a per-step figure
   *  from). */
  freeGapPct?: number;
  /** Σ `blockCounts.{redactedThinking,serverToolUse,other}` over the step's turns — content
   *  Anthropic bills as output but never reveals, so it can only be SIZED (via the residual
   *  fields above), never tokenized. Unrelated to ordinary `thinking`/`thinkingWithheld`, which
   *  is common and handled via `thinkingTokens`/`withheldThinkingTokens` — this is the genuinely
   *  opaque, never-reconstructable-even-approximately category. `undefined`, NOT `0`, when no
   *  turn in the step carried a `blockCounts` field at all (Phase 1 is forward-only) — must not
   *  be read as "confirmed no opaque blocks occurred". */
  opaqueBlocks?: number;
  /** Present only in `'calibrated'` mode — diagnostic, not asserted against in tests.
   *  `freeResponseCount`/`freeChars`/`freeTokens`/`ratio` are THIS STEP's OWN local
   *  free-response numbers (useful for spotting a thin-sample step); NONE of these four is what
   *  `withheldThinkingTokens` was actually computed from — that is `appliedScaleFactor` below
   *  (D6, this revision), not `appliedRatio`. `appliedRatio` is the RUN-WIDE `calibrationRatio`
   *  (chars/token) — kept for interpretability but no longer applied to anything (D6). All three
   *  — a step's own `ratio`, the run-wide `appliedRatio`, and the run-wide `appliedScaleFactor` —
   *  are deliberately separate fields so a consumer can never mistake one for another. */
  calibration?: {
    freeResponseCount: number;
    freeChars: number;
    freeTokens: number;
    /** `undefined` exactly when THIS step's own `freeTokens === 0` — independent of the
     *  run-wide zero-free-response guard on `calibrationRatio` itself; `appliedRatio` can still
     *  be defined here even when `ratio` is not, since the run-wide pool draws from every step. */
    ratio?: number;
    /** The run-wide `calibrationRatio` (chars/token) — retained from this revision on as an
     *  interpretability diagnostic ONLY (D6): it is no longer what `withheldThinkingTokens` or
     *  any `calibrated*Tokens` field is computed from — see `appliedScaleFactor` below.
     *  `undefined` only when the whole run had zero thinking-free responses. */
    appliedRatio?: number;
    /** NEW, D6 this revision. The run-wide `tokenScaleFactor` (`freeTokens / freeTokenized`)
     *  actually applied to compute this step's `withheldThinkingTokens` AND
     *  `calibratedNarrationTokens`/`calibratedToolArgTokens`/`calibratedThinkingTokens`/
     *  `calibratedMeasuredTokens` — `undefined` only when the whole run had zero thinking-free
     *  responses. This is the field that answers "what did the headline numbers actually get
     *  scaled by" — `appliedRatio` above is a diagnostic sitting beside it, not an alternative
     *  reading of it. */
    appliedScaleFactor?: number;
  };
  /** `RunStats.totals.tokenBreakdown` ONLY — always `undefined` on a per-step `TokenBreakdown`.
   *  Count of steps in the run whose own `tokenBreakdown.opaqueBlocks` was `undefined` (no turn
   *  carried `blockCounts`), i.e. excluded from the `opaqueBlocks` sum. */
  stepsWithoutBlockCounts?: number;
  /** `RunStats.totals.tokenBreakdown` ONLY — always `undefined` on a per-step `TokenBreakdown`.
   *  Count of steps in the run whose own `tokenBreakdown.mode` was NOT `'calibrated'`, i.e.
   *  excluded from the `withheldThinkingTokens`/`calibratedResidual` sums. */
  stepsNotCalibrated?: number;
}

/**
 * A real tokenizer's `text → token count`, injected rather than imported at this module's top
 * level (spec Risk R8/R10 — a tokenizer dependency must not add cold-start cost to every `cezar`
 * invocation, only to the one that actually reads token stats). `computeRunStats` stays pure and
 * synchronous whether or not one is supplied; `readRunStats` is the one caller that supplies it,
 * via a lazily `import('gpt-tokenizer')`ed one. Omitting it (the default) forces every step's
 * `tokenBreakdown.mode` to `'unavailable'` — nothing beyond `reportedTokens` can be measured
 * without a tokenizer, the same "undefined, never a fake number" contract `'unavailable'` mode
 * already gives a step with no `item.*` events.
 */
export type Tokenize = (text: string) => number;

/**
 * One de-duplicated API response from a Claude Code session transcript
 * (`~/.claude/projects/*&#47;<sessionId>.jsonl`), classified for calibrated-mode reconciliation
 * (Phase 2). The transcript carries ONE JSON record per raw content block, not per response — a
 * multi-block response is split across several records that all repeat the SAME `usage`
 * (measured on `70f19253`: 628 records / 272 unique `message.id`, naively summing overcounts
 * 2.5×) — so building this shape means grouping transcript records by `message.id` FIRST
 * (`readRunStats`'s job, the one fs-touching function; see Implementation-critical rule #1).
 */
export interface TranscriptResponse {
  messageId: string;
  /** This response's own `usage.output_tokens` — identical across every record in its group, by
   *  construction (Anthropic repeats the whole response's usage on every block record). */
  outputTokens: number;
  /** Whether this response carries at least one `thinking` content block, blank or not. */
  thinkingBearing: boolean;
  /** `text` block text length + `JSON.stringify(tool_use.input)` length, summed — the
   *  "thinking-free" chars a calibration ratio and `freeGapPct` are built from. Excludes
   *  thinking-block text entirely (see `thinkingChars`). */
  visibleChars: number;
  /** Non-blank `thinking` block text length, summed — 0 for a blank/withheld block or a response
   *  with no thinking block at all. Folded into `visibleText` (below) so a response whose thinking
   *  was actually visible does not get double-counted as both measured and withheld. */
  thinkingChars: number;
  /** The concatenated text this response's chars were measured from — narration text, tool-arg
   *  JSON, and (D6, this revision) any NON-BLANK thinking text, newline-joined. **Widened this
   *  revision (D6/D7 nit) — previously `undefined` for a thinking-bearing response, since only
   *  free responses needed tokenizing under the old chars/ratio formula.** Now ALWAYS defined:
   *  `freeGapPct` still tokenizes only the free-response subset of this field, but
   *  `bearingVisibleTokenized` (the `withheldThinkingTokens` formula's own denominator, Solution)
   *  tokenizes it for the bearing subset too — so a bearing response's visible text (and any
   *  visible thinking text) must be real, tokenizable content, not `undefined`. */
  visibleText: string;
}

/** Whole-run tool economy: the per-step rows plus their totals. */
export interface RunStats {
  runId: string;
  /** First → last event. Always ≥ the sum of step wall clocks (queueing, gaps between steps). */
  spanMs: number;
  steps: StepStats[];
  /**
   * Summed across steps — **except `peakContextTokens`, which is the MAX**. `wallMs` is the SUM
   * of step wall clocks, not the run span — those are different numbers and both are worth
   * seeing (60.0 min vs 61.5 min on `ec6e8e06`).
   *
   * `totals.tokenBreakdown`: `reportedTokens` always SUMs across every step (required in every
   * mode). `narrationTokens`/`toolArgTokens`/`thinkingTokens`/`childToolArgTokens`/
   * `measuredTokens` SUM only across steps where each is itself defined (a run mixing
   * `'unavailable'` with measurable steps undercounts by exactly the unavailable steps' own
   * contribution, which by definition carried no measured information to add — no separate
   * exclusion counter is needed, since `totals.mode` already reports `'unavailable'` when every
   * step was). `opaqueBlocks` sums only across steps where it was itself defined, plus
   * `stepsWithoutBlockCounts` names how many were excluded. `withheldThinkingTokens`,
   * `calibratedResidual`, and (D6, this revision) `calibratedNarrationTokens`/
   * `calibratedToolArgTokens`/`calibratedThinkingTokens`/`calibratedMeasuredTokens` all sum only
   * across `'calibrated'` steps, plus `stepsNotCalibrated` — each step's own contribution already
   * used the correct run-wide `tokenScaleFactor` at compute time, so summing the already-scaled
   * per-step values is correct; a run-level `tokenScaleFactor` is never re-derived from the
   * summed totals and reapplied (that would be redundant, not more accurate). `mode` on a
   * mixed-mode run is `'calibrated'` if ANY step was calibrated, else `'basic'` if any step
   * was basic, else `'unavailable'`. `freeGapPct` and `calibration` are ALWAYS `undefined` on
   * totals — both are per-step diagnostics of different sample sizes, never a fabricated
   * run-level average (spec Risk R9 — the same class of bug the peak-context fix above was about).
   */
  totals: Omit<StepStats, 'stepId' | 'restarts'>;
}

function msOf(ts: unknown): number | undefined {
  if (typeof ts !== 'string') return undefined;
  const value = Date.parse(ts);
  return Number.isFinite(value) ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function ratio(calls: number, roundTrips: number): number {
  return roundTrips === 0 ? 0 : Math.round((calls / roundTrips) * 100) / 100;
}

/** The v2 item payload this meter reads. Every field optional — it is parsed off disk. */
interface ToolItem {
  kind?: unknown;
  id?: unknown;
  name?: unknown;
  toolKind?: unknown;
  parentItemId?: unknown;
}

/**
 * The tool item on an `item.started` / `item.completed` event, or `undefined` for anything else
 * (message items, non-item events, malformed lines).
 *
 * Both lifecycle events are read even though `item.started` alone carries everything needed: they
 * describe the SAME id, so the sets are identical, and accepting both means a transcript trimmed
 * to completions still attributes correctly.
 */
function toolItemOf(event: RunEvent): ToolItem | undefined {
  if (event.type !== 'item.started' && event.type !== 'item.completed') return undefined;
  const item = (event as { item?: unknown }).item;
  if (typeof item !== 'object' || item === null) return undefined;
  const candidate = item as ToolItem;
  return candidate.kind === 'tool' ? candidate : undefined;
}

/**
 * What the v2 item stream knows about a run's tool calls, keyed by the id the v1 stream uses too.
 *
 * All three sets are empty for a transcript with no `item.*` events — every pre-v2 recording, and
 * the `ec6e8e06` fixture. That is the degradation path, and it is exact: with `known` empty, every
 * call is "own", `roundTrips` and `batchFactor` are computed exactly as before, and `subAgentCalls`
 * falls back to a name match. Nothing about an old log's numbers moves.
 */
interface ItemIndex {
  /** Every tool item id seen. A call absent from here has no v2 record → fall back by name. */
  known: Set<string>;
  /** Items that ran inside a sub-agent's window. Their calls are the child's spend, not ours. */
  childIds: Set<string>;
  /** Items that ARE a dispatch: `toolKind: 'task'` minus the `Skill` case. */
  dispatchIds: Set<string>;
}

/** The v2 item payload {@link tokenBreakdownItemOf} reads — every field optional, parsed off disk. */
interface BreakdownItem {
  kind?: unknown;
  id?: unknown;
  text?: unknown;
  input?: unknown;
  parentItemId?: unknown;
}

/** A `'message'` / `'reasoning'` / `'tool'` item on an `item.started` or `item.completed` event,
 *  or `undefined` for anything else. Both lifecycle events are read for TOOL items — a tool's
 *  `item.completed` can lose its `input` on the mapper's state-loss path
 *  (`claude-ui-mapper.ts:454` — a result for a tool cezar never saw start), so
 *  {@link computeRunStats} falls back to `item.started`'s input, deduped by id, exactly the
 *  `item.started`/`item.completed` overlap {@link indexToolItems} already tolerates. */
function tokenBreakdownItemOf(event: RunEvent): BreakdownItem | undefined {
  if (event.type !== 'item.started' && event.type !== 'item.completed') return undefined;
  const item = (event as { item?: unknown }).item;
  if (typeof item !== 'object' || item === null) return undefined;
  return item as BreakdownItem;
}

/** The `usage.output` + `blockCounts`/`childBlockCounts` payload a `turn.completed` event
 *  carries, or `undefined` for anything else. `blockCounts` is `undefined` both for a non-claude
 *  backend and for a turn recorded before Phase 1 shipped — {@link computeRunStats} cannot tell
 *  those apart, which is exactly why "blockCounts available" reads as "unknown", never
 *  "confirmed zero", in either case. */
function turnCompletedOf(event: RunEvent): {
  outputTokens: number | undefined;
  blockCounts: Record<string, unknown> | undefined;
} | undefined {
  if (event.type !== 'turn.completed') return undefined;
  const usage = (event as { usage?: unknown }).usage;
  const outputTokens =
    typeof usage === 'object' && usage !== null ? numberOf((usage as { output?: unknown }).output) : undefined;
  const blockCounts = (event as { blockCounts?: unknown }).blockCounts;
  return {
    outputTokens,
    blockCounts: typeof blockCounts === 'object' && blockCounts !== null ? (blockCounts as Record<string, unknown>) : undefined,
  };
}

/** `session.started`'s `sessionId` + the `stepId` it was stamped with, or `undefined` for
 *  anything else — the join key between cezar's own NDJSON and a Claude Code session transcript
 *  (`~/.claude/projects/*&#47;<sessionId>.jsonl`, `readRunStats`). A restarted step has more than
 *  one `session.started`, one per attempt — all of them belong to the step. */
function sessionStartedOf(event: RunEvent): { sessionId: string; stepId: string } | undefined {
  if (event.type !== 'session.started') return undefined;
  const sessionId = stringOf((event as { sessionId?: unknown }).sessionId);
  const stepId = stringOf(event.stepId);
  return sessionId !== undefined && stepId !== undefined ? { sessionId, stepId } : undefined;
}

function indexToolItems(ordered: readonly RunEvent[]): ItemIndex {
  const index: ItemIndex = { known: new Set(), childIds: new Set(), dispatchIds: new Set() };
  for (const event of ordered) {
    const item = toolItemOf(event);
    if (!item) continue;
    const id = stringOf(item.id);
    if (id === undefined) continue;
    index.known.add(id);
    if (stringOf(item.parentItemId) !== undefined) index.childIds.add(id);
    // `Skill` shares `toolKind: 'task'` with a real dispatch (`tool-display.ts:159-165` groups the
    // two for display). Counting it would let a step pass a fan-out check by invoking a skill —
    // and `document`, the step this is measured on, is the one most likely to call one.
    if (item.toolKind === 'task' && stringOf(item.name)?.toLowerCase() !== 'skill') index.dispatchIds.add(id);
  }
  return index;
}

/**
 * The distinct `parentItemId` values in a transcript — every item id that fathered at least one
 * child item.
 *
 * **A cross-check, not the rule.** It identifies a dispatch structurally, so it is immune to both
 * tool spelling and the `Skill` collision for free; but it misses a dispatch whose sub-agent
 * produced no items, which is why {@link indexToolItems} keys on `toolKind` instead. The two
 * definitions agreed exactly (3 === 3) on both fanned-out transcripts, and a test pins that
 * agreement — so a future tool mapped to `toolKind: 'task'` surfaces as a failing test rather than
 * as a silently inflated metric.
 */
export function dispatchIdsByStructure(events: readonly RunEvent[]): Set<string> {
  const parents = new Set<string>();
  for (const event of events) {
    const item = (event as { item?: unknown }).item;
    if (typeof item !== 'object' || item === null) continue;
    const parentItemId = stringOf((item as ToolItem).parentItemId);
    if (parentItemId !== undefined) parents.add(parentItemId);
  }
  return parents;
}

interface Bucket {
  starts: number[];
  ends: number[];
  toolCalls: number;
  childToolCalls: number;
  roundTrips: number;
  toolExecMs: number;
  modelMs: number;
  cheapCalls: number;
  cheapExecMs: number;
  subAgentCalls: number;
  peakContextTokens?: number;
  sleepCalls: number;
  blindSleepCalls: number;
  sleepExecMs: number;
  toolInputChars: number;
  heredocChars: number;
  heredocFileWrites: number;
  heredocRewrites: number;
  heredocRewriteWasteChars: number;
  /** Every expensive invocation this step made, in order — grouped into repeats after the replay,
   *  because whether a group counts depends on how long its FIRST call took. */
  expensive: Array<{ key: string; callId: string | undefined }>;
  /** Non-child `'message'` `item.completed` text — tokenized once, at assembly time. */
  narrationTexts: string[];
  /** Non-child `'reasoning'` `item.completed` text (non-blank only, by construction — the
   *  mapper never mints one for a blank block). */
  reasoningTexts: string[];
  reportedTokens: number;
  opaqueBlocks: number;
  /** Whether this step emitted at least one `turn.completed` — gates whether `tokenBreakdown`
   *  is built at all, same as `peakContextTokens`'s own undefined-vs-sampled distinction. */
  hasTurnCompleted: boolean;
  /** Whether this step emitted at least one `item.*` event — `mode: 'unavailable'` otherwise
   *  (spec N9: tightened to an item-presence check, not a backend check). */
  hasItems: boolean;
  /** Starts `true`; flips to `false` the first turn whose `blockCounts` is `undefined`. A step
   *  with turns from BOTH eras (pre- and post-Phase-1) reads as unavailable as a whole, rather
   *  than silently mixing a known zero with an unknown one. */
  blockCountsAvailable: boolean;
  /** Every distinct `sessionId` this step ran under (one per attempt, on a restarted step) — the
   *  join key into the `transcripts` map for calibrated mode. */
  sessionIds: Set<string>;
}

function emptyBucket(): Bucket {
  return {
    starts: [],
    ends: [],
    toolCalls: 0,
    childToolCalls: 0,
    roundTrips: 0,
    toolExecMs: 0,
    modelMs: 0,
    cheapCalls: 0,
    cheapExecMs: 0,
    subAgentCalls: 0,
    sleepCalls: 0,
    blindSleepCalls: 0,
    sleepExecMs: 0,
    toolInputChars: 0,
    heredocChars: 0,
    heredocFileWrites: 0,
    heredocRewrites: 0,
    heredocRewriteWasteChars: 0,
    expensive: [],
    narrationTexts: [],
    reasoningTexts: [],
    reportedTokens: 0,
    opaqueBlocks: 0,
    hasTurnCompleted: false,
    hasItems: false,
    blockCountsAvailable: true,
    sessionIds: new Set(),
  };
}

/** One tool item's `input`, tracked by id across `item.started`/`item.completed` so a
 *  state-loss-on-completion tool (`claude-ui-mapper.ts:454`) still contributes the input its
 *  `item.started` carried. Whichever event most recently carried a defined `input` wins — in
 *  practice `item.completed`'s does, except on the state-loss path, where it has none and
 *  `item.started`'s stands. */
interface ToolInputEntry {
  stepId: string;
  isChild: boolean;
  input: unknown;
  hasInput: boolean;
}

/**
 * Repeats of an expensive invocation, counted per step.
 *
 * First-call-only on the 5 s test: a command that is cheap the first time and slow later is not
 * this defect. A group whose first call has no recorded result is skipped rather than guessed at —
 * under-reporting, in the same direction as every other unknown here.
 */
function countRepeatedExpensive(
  entries: ReadonlyArray<{ key: string; callId: string | undefined }>,
  execById: ReadonlyMap<string, number>,
): number {
  const groups = new Map<string, Array<string | undefined>>();
  for (const entry of entries) {
    const existing = groups.get(entry.key);
    if (existing) existing.push(entry.callId);
    else groups.set(entry.key, [entry.callId]);
  }
  let repeated = 0;
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const firstId = ids[0];
    const firstExecMs = firstId === undefined ? undefined : execById.get(firstId);
    if (firstExecMs === undefined || firstExecMs < EXPENSIVE_CALL_MS) continue;
    repeated += ids.length - 1;
  }
  return repeated;
}

/**
 * Replay a run's events into per-step tool-economy metrics.
 *
 * Pure and order-independent at the input (events are sorted by `seq` first), so it can be fed a
 * live in-memory tail or a file read back years later. The v2 item pre-pass runs over the whole
 * sorted array before any counting, so an item that lands after its own `tool-call` — or is only
 * ever seen as `item.completed` — still attributes correctly.
 *
 * **How a "round trip" is counted, and why it is a heuristic.** A run's NDJSON has no per-
 * assistant-message event: `turn.started` fires once per *step invocation* (10 times against 271
 * tool calls on `ec6e8e06`), so it cannot be used. What the transcript *does* preserve is order —
 * when a model emits several `tool_use` blocks in ONE turn, their `tool-call` events land back to
 * back with no `tool-result` between them. So a round trip is **a maximal run of consecutive OWN
 * `tool-call` events within one step**, and `batchFactor` is own calls ÷ those runs. The failure
 * mode is benign and in the conservative direction: a batch whose first result somehow interleaved
 * would be counted as two round trips, i.e. it would UNDER-report batching, never invent it.
 *
 * **Why children are skipped entirely rather than merely subtracted.** A sub-agent's calls and
 * results are interleaved with the parent's in one stream. Leaving the results in would clear the
 * open batch (a `tool-result` is what ends one), splitting a parent's single batched turn into as
 * many round trips as its children happened to interrupt — so the child's *results* must be
 * dropped along with its calls, or the fix undoes itself.
 */
export function computeRunStats(
  runId: string,
  events: readonly RunEvent[],
  transcripts?: ReadonlyMap<string, readonly TranscriptResponse[]>,
  tokenize?: Tokenize,
): RunStats {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const items = indexToolItems(ordered);
  const buckets = new Map<string, Bucket>();
  const bucketFor = (stepId: string): Bucket => {
    const existing = buckets.get(stepId);
    if (existing) return existing;
    const created = emptyBucket();
    buckets.set(stepId, created);
    return created;
  };
  /** Tool item inputs, deduped by id across `item.started`/`item.completed` — see
   *  {@link ToolInputEntry}. Populated regardless of `tokenize`; only tokenized at assembly time. */
  const toolInputs = new Map<string, ToolInputEntry>();

  /** `tool-call` id → its start time + owning step, so a result can be matched back to it. */
  const pending = new Map<
    string,
    { stepId: string; startedAt: number; tool: string | undefined; isSleep: boolean }
  >();
  /** `tool-call` id → measured exec ms. Kept after the pair is matched, because
   *  `repeatedExpensiveCalls` needs the FIRST call of a group long after that call closed. */
  const execById = new Map<string, number>();
  /** Last `tool-result` timestamp per step — the left edge of the next model gap. */
  const lastResultAt = new Map<string, number>();
  /** Was the previous OWN tool event in THIS step a call? If so, the next call joins its round trip. */
  let openBatchStep: string | undefined;

  /** Run-wide (not per-step): every path a file-authoring heredoc has targeted, or that a `Read`
   *  call / a `cat`/`head`/`tail`/`sed -n …p` Bash command has read, EARLIER in this same replay. */
  const seenPaths = new Set<string>();
  /** Run-wide: the last body written to a path via a file-authoring heredoc — what
   *  `heredocRewriteWasteChars` diffs the next write to that path against. Capped per
   *  `MAX_RETAINED_BODY_BYTES`; an oversized body is dropped rather than retained. */
  const lastBodyByPath = new Map<string, string[]>();

  let firstTs: number | undefined;
  let lastTs: number | undefined;

  for (const event of ordered) {
    const ts = msOf(event.ts);
    if (ts !== undefined) {
      if (firstTs === undefined) firstTs = ts;
      lastTs = ts;
    }
    const stepId = stringOf(event.stepId);

    switch (event.type) {
      case 'step-start': {
        if (stepId && ts !== undefined) bucketFor(stepId).starts.push(ts);
        break;
      }
      case 'step-end': {
        if (stepId && ts !== undefined) bucketFor(stepId).ends.push(ts);
        break;
      }
      case 'tool-call': {
        const key = stepId ?? NO_STEP;
        const bucket = bucketFor(key);
        bucket.toolCalls += 1;
        const id = stringOf((event as { id?: unknown }).id);

        // Character economy — SAME SCOPE as `toolCalls` (children included), so this runs before
        // the childIds break below. See `toolInputChars`' doc comment for why.
        const input = (event as { input?: unknown }).input;
        const inputChars = input === undefined ? 0 : JSON.stringify(input).length;
        bucket.toolInputChars += inputChars;

        const toolName = stringOf((event as { tool?: unknown }).tool);
        if (toolName === 'Bash' && typeof input === 'object' && input !== null) {
          const command = commandOf(event);
          const strippedChars = JSON.stringify({ ...input, command: stripHeredocs(command) }).length;
          bucket.heredocChars += Math.max(0, inputChars - strippedChars);

          for (const entry of heredocEntriesOf(command)) {
            const path = authoredPathOf(entry.openerLine);
            if (path === undefined) continue;
            bucket.heredocFileWrites += 1;
            if (seenPaths.has(path)) {
              bucket.heredocRewrites += 1;
              const priorBody = lastBodyByPath.get(path);
              if (priorBody !== undefined) {
                bucket.heredocRewriteWasteChars += unchangedLineCharsOf(priorBody, entry.body);
              }
            }
            seenPaths.add(path);
            const bodyBytes = entry.body.reduce((n, l) => n + l.length + 1, 0);
            if (bodyBytes <= MAX_RETAINED_BODY_BYTES) lastBodyByPath.set(path, entry.body);
            else lastBodyByPath.delete(path);
          }
          for (const readPath of readTargetsOf(command)) seenPaths.add(readPath);
        } else if (toolName === 'Read') {
          const filePath = stringOf((input as { file_path?: unknown } | null | undefined)?.file_path);
          if (filePath !== undefined) seenPaths.add(filePath);
        }

        // A sub-agent's call, spending the CHILD's window. It is counted and then dropped: it
        // must not open a round trip, bill exec time, or claim a dispatch of its own.
        if (id !== undefined && items.childIds.has(id)) {
          bucket.childToolCalls += 1;
          break;
        }

        // A new round trip unless the immediately preceding own tool event was a call in this same
        // step — that is a second `tool_use` block riding along in one assistant turn.
        if (openBatchStep !== key) bucket.roundTrips += 1;
        openBatchStep = key;

        const tool = stringOf((event as { tool?: unknown }).tool);
        const dispatched =
          id !== undefined && items.known.has(id)
            ? items.dispatchIds.has(id)
            : FALLBACK_DISPATCH_NAMES.has((tool ?? '').toLowerCase());
        if (dispatched) bucket.subAgentCalls += 1;

        // The waiting and repetition meters read the COMMAND, which every other counter here
        // ignores. `input` has always been persisted on `tool-call`; this is the first thing to
        // read it. Bash only — a `sleep` inside a Read is not a thing.
        const signals = tool === 'Bash' ? signalsOf(commandOf(event)) : undefined;
        if (signals?.isSleep) bucket.sleepCalls += 1;
        if (signals?.isBlindSleep) bucket.blindSleepCalls += 1;

        const since = lastResultAt.get(key);
        if (since !== undefined && ts !== undefined) {
          const gap = ts - since;
          if (gap >= 0 && gap < MAX_MODEL_GAP_MS) bucket.modelMs += gap;
        }
        if (signals?.expensiveKey) bucket.expensive.push({ key: signals.expensiveKey, callId: id });
        if (id && ts !== undefined) {
          pending.set(id, { stepId: key, startedAt: ts, tool, isSleep: signals?.isSleep ?? false });
        }
        break;
      }
      case 'tool-result': {
        const id = stringOf((event as { toolCallId?: unknown }).toolCallId);
        // A child's result belongs to the child's turn. Letting it through here would close the
        // parent's open batch and inflate its round trips — see the doc comment above.
        if (id !== undefined && items.childIds.has(id)) break;
        const key = stepId ?? NO_STEP;
        openBatchStep = undefined;
        if (ts !== undefined) lastResultAt.set(key, ts);
        if (id === undefined || ts === undefined) break;
        const call = pending.get(id);
        if (!call) break;
        pending.delete(id);
        const bucket = bucketFor(call.stepId);
        const execMs = Math.max(0, ts - call.startedAt);
        execById.set(id, execMs);
        bucket.toolExecMs += execMs;
        if (call.isSleep) bucket.sleepExecMs += execMs;
        if (execMs < CHEAP_CALL_MS) {
          bucket.cheapCalls += 1;
          bucket.cheapExecMs += execMs;
        }
        break;
      }
      case 'context.updated': {
        const tokens = numberOf((event as { contextTokens?: unknown }).contextTokens);
        if (tokens === undefined) break;
        const bucket = bucketFor(stepId ?? NO_STEP);
        bucket.peakContextTokens = Math.max(bucket.peakContextTokens ?? 0, tokens);
        break;
      }
      case 'item.started':
      case 'item.completed': {
        const item = tokenBreakdownItemOf(event);
        if (!item) break;
        const bucket = bucketFor(stepId ?? NO_STEP);
        bucket.hasItems = true;
        // Own AND sub-agent items alike are collected — `reportedTokens` (below) sums the WHOLE
        // turn, every internal round-trip included, so a dispatched sub-agent's own tool calls
        // ARE part of the wire the model streamed, but `turn.completed.usage.output` never bills
        // them (they are billed to the sub-agent's own turn, under its own session) — hence the
        // parent/child split below at assembly time, not here.
        if (item.kind === 'message' && typeof item.text === 'string' && event.type === 'item.completed') {
          if (item.parentItemId === undefined) bucket.narrationTexts.push(item.text);
        } else if (item.kind === 'reasoning' && typeof item.text === 'string' && event.type === 'item.completed') {
          if (item.parentItemId === undefined) bucket.reasoningTexts.push(item.text);
        } else if (item.kind === 'tool') {
          const id = stringOf(item.id);
          if (id === undefined) break;
          const existing = toolInputs.get(id);
          // This event's own input wins when present; otherwise fall back to whatever is already
          // stored. This is what recovers `item.started`'s input on the mapper's state-loss path
          // (`claude-ui-mapper.ts:454`), where `item.completed` arrives with NO `input` at all —
          // taking `item.completed`'s input unconditionally would silently ERASE a real value
          // `item.started` already captured.
          const hasNewInput = item.input !== undefined;
          toolInputs.set(id, {
            stepId: stepId ?? NO_STEP,
            isChild: item.parentItemId !== undefined,
            input: hasNewInput ? item.input : existing?.input,
            hasInput: hasNewInput || (existing?.hasInput ?? false),
          });
        }
        break;
      }
      case 'turn.completed': {
        const turn = turnCompletedOf(event);
        if (!turn) break;
        const bucket = bucketFor(stepId ?? NO_STEP);
        bucket.hasTurnCompleted = true;
        if (turn.outputTokens !== undefined) bucket.reportedTokens += turn.outputTokens;
        if (turn.blockCounts === undefined) {
          bucket.blockCountsAvailable = false;
        } else {
          bucket.opaqueBlocks +=
            (numberOf(turn.blockCounts.redactedThinking) ?? 0) +
            (numberOf(turn.blockCounts.serverToolUse) ?? 0) +
            (numberOf(turn.blockCounts.other) ?? 0);
        }
        break;
      }
      case 'session.started': {
        const started = sessionStartedOf(event);
        if (started) bucketFor(started.stepId).sessionIds.add(started.sessionId);
        break;
      }
      default:
        break;
    }
  }

  // ---- token breakdown assembly (Phase 2) ------------------------------------------------

  /** Every tool item's tokenized input, split own/child, grouped by step — computed once, after
   *  the replay, now that `item.completed` has had the chance to override `item.started`'s entry. */
  const toolArgTokensByStep = new Map<string, number>();
  const childToolArgTokensByStep = new Map<string, number>();
  if (tokenize) {
    for (const entry of toolInputs.values()) {
      const tokens = tokenize(entry.hasInput ? JSON.stringify(entry.input) : '');
      const bucket = entry.isChild ? childToolArgTokensByStep : toolArgTokensByStep;
      bucket.set(entry.stepId, (bucket.get(entry.stepId) ?? 0) + tokens);
    }
  }

  /** RUN-WIDE calibration ratio AND scale factor — both pooled across EVERY step's thinking-free
   *  transcript responses before any per-step computation (spec N4: a per-step pool is unstable
   *  on a thin sample), computed ONCE here rather than per step (D6, this revision — the same
   *  pooling argument that already applied to `calibrationRatio` now applies to `tokenScaleFactor`,
   *  the value calibrated fields are actually scaled by). `calibrationRatio` (chars/token) is kept
   *  only as an interpretability diagnostic from this revision on — `tokenScaleFactor` (billed
   *  tokens / this tokenizer's own count, on the SAME visible text) is what `withheldThinkingTokens`
   *  and every `calibrated*Tokens` field is actually computed from. Both `undefined` when the run
   *  has zero thinking-free responses anywhere, or no `tokenize` function was supplied — every step
   *  then reports `mode: 'basic'`, never a `NaN`. */
  let calibrationRatio: number | undefined;
  let tokenScaleFactor: number | undefined;
  if (transcripts && tokenize) {
    let freeChars = 0;
    let freeTokens = 0;
    let freeTokenized = 0;
    for (const responses of transcripts.values()) {
      for (const r of responses) {
        if (r.thinkingBearing) continue;
        freeChars += r.visibleChars;
        freeTokens += r.outputTokens;
        freeTokenized += tokenize(r.visibleText);
      }
    }
    calibrationRatio = freeTokens === 0 ? undefined : freeChars / freeTokens;
    tokenScaleFactor = freeTokens === 0 ? undefined : freeTokens / freeTokenized;
  }

  const steps: StepStats[] = [...buckets.entries()].map(([stepId, b]) => ({
    stepId,
    wallMs: b.starts.length > 0 && b.ends.length > 0 ? Math.max(0, Math.max(...b.ends) - Math.min(...b.starts)) : 0,
    restarts: Math.max(0, b.starts.length - 1),
    toolCalls: b.toolCalls,
    childToolCalls: b.childToolCalls,
    ownToolCalls: b.toolCalls - b.childToolCalls,
    roundTrips: b.roundTrips,
    batchFactor: ratio(b.toolCalls - b.childToolCalls, b.roundTrips),
    peakContextTokens: b.peakContextTokens,
    toolExecMs: b.toolExecMs,
    modelMs: b.modelMs,
    cheapCalls: b.cheapCalls,
    cheapExecMs: b.cheapExecMs,
    subAgentCalls: b.subAgentCalls,
    sleepCalls: b.sleepCalls,
    blindSleepCalls: b.blindSleepCalls,
    sleepExecMs: b.sleepExecMs,
    repeatedExpensiveCalls: countRepeatedExpensive(b.expensive, execById),
    tokenBreakdown: b.hasTurnCompleted
      ? tokenBreakdownOf(
          stepId,
          b,
          toolArgTokensByStep,
          childToolArgTokensByStep,
          transcripts,
          calibrationRatio,
          tokenScaleFactor,
          tokenize,
        )
      : undefined,
    toolInputChars: b.toolInputChars,
    heredocChars: b.heredocChars,
    heredocFileWrites: b.heredocFileWrites,
    heredocRewrites: b.heredocRewrites,
    heredocRewriteWasteChars: b.heredocRewriteWasteChars,
  }));

  const sum = (pick: (s: StepStats) => number): number => steps.reduce((acc, s) => acc + pick(s), 0);
  const toolCalls = sum((s) => s.toolCalls);
  const childToolCalls = sum((s) => s.childToolCalls);
  const roundTrips = sum((s) => s.roundTrips);
  // MAX, not sum: every step is a separate agent session with its own window, so summing peaks
  // would invent a number no window ever held.
  const sampled = steps.map((s) => s.peakContextTokens).filter((v): v is number => v !== undefined);
  const withBreakdown = steps.map((s) => s.tokenBreakdown).filter((v): v is TokenBreakdown => v !== undefined);

  return {
    runId,
    spanMs: firstTs !== undefined && lastTs !== undefined ? Math.max(0, lastTs - firstTs) : 0,
    steps,
    totals: {
      wallMs: sum((s) => s.wallMs),
      toolCalls,
      childToolCalls,
      ownToolCalls: toolCalls - childToolCalls,
      roundTrips,
      batchFactor: ratio(toolCalls - childToolCalls, roundTrips),
      peakContextTokens: sampled.length > 0 ? Math.max(...sampled) : undefined,
      toolExecMs: sum((s) => s.toolExecMs),
      modelMs: sum((s) => s.modelMs),
      cheapCalls: sum((s) => s.cheapCalls),
      cheapExecMs: sum((s) => s.cheapExecMs),
      subAgentCalls: sum((s) => s.subAgentCalls),
      sleepCalls: sum((s) => s.sleepCalls),
      blindSleepCalls: sum((s) => s.blindSleepCalls),
      sleepExecMs: sum((s) => s.sleepExecMs),
      repeatedExpensiveCalls: sum((s) => s.repeatedExpensiveCalls),
      tokenBreakdown: withBreakdown.length > 0 ? sumTokenBreakdowns(withBreakdown) : undefined,
      toolInputChars: sum((s) => s.toolInputChars),
      heredocChars: sum((s) => s.heredocChars),
      heredocFileWrites: sum((s) => s.heredocFileWrites),
      heredocRewrites: sum((s) => s.heredocRewrites),
      heredocRewriteWasteChars: sum((s) => s.heredocRewriteWasteChars),
    },
  };
}

/** 1 decimal place — every `gapPct` in this module rounds the same way. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * One step's {@link TokenBreakdown}. Only called once `b.hasTurnCompleted` is known true (see the
 * caller) — an all-zero breakdown for a step that emitted no turn would misread as "measured and
 * found nothing", not "not measured".
 *
 * Mode selection: `'unavailable'` when there is no `tokenize` function (nothing downstream of
 * `reportedTokens` can be measured at all) OR the step has no `item.*` events (N9 — tightened
 * from a backend check to an item-presence check: every non-claude mapper emits `item.completed`
 * including `kind: 'reasoning'`, so this is genuinely about data availability, not backend).
 * `'calibrated'` when a run-wide `tokenScaleFactor` is computable AND this step has at least one
 * transcript response of its own (joined via its `sessionIds`). `'basic'` otherwise.
 */
function tokenBreakdownOf(
  stepId: string,
  b: Bucket,
  toolArgTokensByStep: ReadonlyMap<string, number>,
  childToolArgTokensByStep: ReadonlyMap<string, number>,
  transcripts: ReadonlyMap<string, readonly TranscriptResponse[]> | undefined,
  calibrationRatio: number | undefined,
  tokenScaleFactor: number | undefined,
  tokenize: Tokenize | undefined,
): TokenBreakdown {
  const reportedTokens = b.reportedTokens;
  const opaqueBlocks = b.blockCountsAvailable ? b.opaqueBlocks : undefined;

  if (!tokenize || !b.hasItems) {
    return { mode: 'unavailable', reportedTokens, opaqueBlocks };
  }

  const narrationTokens = b.narrationTexts.reduce((acc, t) => acc + tokenize(t), 0);
  const thinkingTokens = b.reasoningTexts.reduce((acc, t) => acc + tokenize(t), 0);
  const toolArgTokens = toolArgTokensByStep.get(stepId) ?? 0;
  const childToolArgTokens = childToolArgTokensByStep.get(stepId) ?? 0;
  const measuredTokens = narrationTokens + toolArgTokens + thinkingTokens;

  const stepResponses: TranscriptResponse[] = [];
  if (transcripts) {
    for (const sessionId of b.sessionIds) {
      const responses = transcripts.get(sessionId);
      if (responses) stepResponses.push(...responses);
    }
  }

  if (tokenScaleFactor === undefined || stepResponses.length === 0) {
    return {
      mode: 'basic',
      reportedTokens,
      narrationTokens,
      toolArgTokens,
      childToolArgTokens,
      thinkingTokens,
      measuredTokens,
      unclassifiedGapTokens: reportedTokens - measuredTokens,
      opaqueBlocks,
    };
  }

  const bearing = stepResponses.filter((r) => r.thinkingBearing);
  const free = stepResponses.filter((r) => !r.thinkingBearing);
  const bearingTokens = bearing.reduce((acc, r) => acc + r.outputTokens, 0);
  // D6: tokenized directly (real BPE over visibleText, which now includes any non-blank thinking
  // text — see TranscriptResponse.visibleText) rather than the superseded bearingChars/ratio
  // estimate — puts the withheld inference on the same scale as calibratedNarrationTokens/
  // calibratedToolArgTokens/calibratedThinkingTokens below.
  const bearingVisibleTokenized = bearing.reduce((acc, r) => acc + tokenize(r.visibleText), 0);
  const withheldThinkingTokens = bearingTokens - bearingVisibleTokenized * tokenScaleFactor;

  const calibratedNarrationTokens = narrationTokens * tokenScaleFactor;
  const calibratedToolArgTokens = toolArgTokens * tokenScaleFactor;
  const calibratedThinkingTokens = thinkingTokens * tokenScaleFactor;
  const calibratedMeasuredTokens = calibratedNarrationTokens + calibratedToolArgTokens + calibratedThinkingTokens;
  const calibratedResidual = reportedTokens - (calibratedMeasuredTokens + withheldThinkingTokens);

  const localFreeChars = free.reduce((acc, r) => acc + r.visibleChars, 0);
  const localFreeTokens = free.reduce((acc, r) => acc + r.outputTokens, 0);

  let freeGapPct: number | undefined;
  if (localFreeTokens > 0) {
    const freeMeasuredTokens = free.reduce((acc, r) => acc + tokenize(r.visibleText), 0);
    freeGapPct = round1(((localFreeTokens - freeMeasuredTokens) / localFreeTokens) * 100);
  }

  return {
    mode: 'calibrated',
    reportedTokens,
    narrationTokens,
    toolArgTokens,
    childToolArgTokens,
    thinkingTokens,
    measuredTokens,
    calibratedNarrationTokens,
    calibratedToolArgTokens,
    calibratedThinkingTokens,
    calibratedMeasuredTokens,
    withheldThinkingTokens,
    calibratedResidual,
    freeGapPct,
    opaqueBlocks,
    calibration: {
      freeResponseCount: free.length,
      freeChars: localFreeChars,
      freeTokens: localFreeTokens,
      ratio: localFreeTokens === 0 ? undefined : localFreeChars / localFreeTokens,
      appliedRatio: calibrationRatio,
      appliedScaleFactor: tokenScaleFactor,
    },
  };
}

/**
 * The run-level `tokenBreakdown` — every field summed component-wise ONLY across steps where
 * that field is itself defined (spec Risk R9 — no fabricated run-level average). `mode` follows
 * `'calibrated'` > `'basic'` > `'unavailable'` precedence: a run counts as calibrated the moment
 * any one of its steps is. `freeGapPct`/`calibration` are per-step diagnostics of different
 * sample sizes and are never summed or averaged onto totals — they stay `undefined` here always.
 */
function sumTokenBreakdowns(breakdowns: readonly TokenBreakdown[]): TokenBreakdown {
  const reportedTokens = breakdowns.reduce((acc, t) => acc + t.reportedTokens, 0);

  const sumDefined = (pick: (t: TokenBreakdown) => number | undefined): number | undefined => {
    const defined = breakdowns.map(pick).filter((v): v is number => v !== undefined);
    return defined.length > 0 ? defined.reduce((a, v) => a + v, 0) : undefined;
  };

  const withBlockCounts = breakdowns.filter((t) => t.opaqueBlocks !== undefined);
  const withCalibration = breakdowns.filter((t) => t.mode === 'calibrated');

  const mode: TokenBreakdownMode =
    withCalibration.length > 0 ? 'calibrated' : breakdowns.some((t) => t.mode === 'basic') ? 'basic' : 'unavailable';

  return {
    mode,
    reportedTokens,
    narrationTokens: sumDefined((t) => t.narrationTokens),
    toolArgTokens: sumDefined((t) => t.toolArgTokens),
    childToolArgTokens: sumDefined((t) => t.childToolArgTokens),
    thinkingTokens: sumDefined((t) => t.thinkingTokens),
    measuredTokens: sumDefined((t) => t.measuredTokens),
    // D6, this revision: sum only across 'calibrated' steps, same exclusion set as
    // withheldThinkingTokens/calibratedResidual below — each step's own contribution already
    // used the correct run-wide tokenScaleFactor at compute time, so summing is correct.
    calibratedNarrationTokens:
      withCalibration.length > 0 ? withCalibration.reduce((a, t) => a + (t.calibratedNarrationTokens ?? 0), 0) : undefined,
    calibratedToolArgTokens:
      withCalibration.length > 0 ? withCalibration.reduce((a, t) => a + (t.calibratedToolArgTokens ?? 0), 0) : undefined,
    calibratedThinkingTokens:
      withCalibration.length > 0 ? withCalibration.reduce((a, t) => a + (t.calibratedThinkingTokens ?? 0), 0) : undefined,
    calibratedMeasuredTokens:
      withCalibration.length > 0 ? withCalibration.reduce((a, t) => a + (t.calibratedMeasuredTokens ?? 0), 0) : undefined,
    withheldThinkingTokens:
      withCalibration.length > 0 ? withCalibration.reduce((a, t) => a + (t.withheldThinkingTokens ?? 0), 0) : undefined,
    calibratedResidual:
      withCalibration.length > 0 ? withCalibration.reduce((a, t) => a + (t.calibratedResidual ?? 0), 0) : undefined,
    opaqueBlocks: withBlockCounts.length > 0 ? withBlockCounts.reduce((a, t) => a + (t.opaqueBlocks ?? 0), 0) : undefined,
    stepsWithoutBlockCounts: breakdowns.length - withBlockCounts.length,
    stepsNotCalibrated: breakdowns.length - withCalibration.length,
  };
}

/** Same character-class guard `stats-cli.ts`'s `validRunId` already applies to `runId` — restated
 *  here rather than imported, to avoid a `stats.ts` ↔ `stats-cli.ts` circular module dependency
 *  for a two-line predicate. `sessionId` is attacker-influenced data (it rides the run's own
 *  NDJSON) reaching a filesystem path, exactly like `runId` already is (D4). */
function validSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(sessionId) && sessionId.length <= 128;
}

/**
 * Find `<sessionId>.jsonl` under `~/.claude/projects/`, whichever project-directory slug it
 * landed in. The directory is NOT deterministically computable from a run's cwd — a single run
 * can have several candidate project directories depending on how a step's worktree/lease was
 * set up (Architecture) — so this globs by filename instead of re-deriving a slug. Returns
 * `undefined` (never throws) when `~/.claude/projects/` itself is missing, or no subdirectory
 * carries the file — both read the same way: no transcript for this session, degrade to basic
 * mode for it.
 */
async function findTranscriptPath(sessionId: string): Promise<string | undefined> {
  const projectsDir = join(homedir(), '.claude', 'projects');
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const candidate = join(projectsDir, entry, `${sessionId}.jsonl`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Not in this project directory — keep looking.
    }
  }
  return undefined;
}

/** One raw Claude Code transcript record, as read off disk — every field optional. */
interface RawTranscriptRecord {
  type?: unknown;
  isSidechain?: unknown;
  message?: { id?: unknown; content?: unknown; usage?: { output_tokens?: unknown } };
}

/**
 * Parse a Claude Code session transcript's lines into deduped {@link TranscriptResponse}s.
 *
 * **Grouping by `message.id` is mandatory** — the transcript carries one JSON record per raw
 * content block, not per response, and every record in a group repeats the SAME `usage`
 * (Implementation-critical rule #1; measured on `70f19253`: naive per-record summing over-counts
 * 2.5×, 940,963 vs the correct 375,001). `isSidechain: true` records — a sub-agent's own turn,
 * embedded inline in the parent's transcript file — are excluded entirely: this join already
 * assumes the transcript holds only the main agent's own responses (Architecture), and a
 * sidechain record would break that assumption if ever present.
 */
export function parseTranscriptResponses(lines: readonly string[]): TranscriptResponse[] {
  const groups = new Map<string, { outputTokens: number; blocks: unknown[] }>();
  for (const line of lines) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const record = parsed as RawTranscriptRecord;
    if (record.type !== 'assistant' || record.isSidechain === true) continue;
    const message = record.message;
    if (typeof message !== 'object' || message === null) continue;
    const messageId = stringOf(message.id);
    const outputTokens = numberOf(
      typeof message.usage === 'object' && message.usage !== null ? message.usage.output_tokens : undefined,
    );
    if (messageId === undefined || outputTokens === undefined) continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const group = groups.get(messageId) ?? { outputTokens, blocks: [] };
    group.blocks.push(...content);
    groups.set(messageId, group);
  }

  const responses: TranscriptResponse[] = [];
  for (const [messageId, group] of groups) {
    let visibleChars = 0;
    let thinkingChars = 0;
    let thinkingBearing = false;
    const visibleParts: string[] = [];
    for (const raw of group.blocks) {
      if (!isRecord(raw)) continue;
      if (raw.type === 'text' && typeof raw.text === 'string') {
        visibleChars += raw.text.length;
        visibleParts.push(raw.text);
      } else if (raw.type === 'tool_use' && raw.input !== undefined) {
        const json = JSON.stringify(raw.input);
        visibleChars += json.length;
        visibleParts.push(json);
      } else if (raw.type === 'thinking') {
        thinkingBearing = true;
        // Non-blank thinking text is real, measurable content (D1) — folded into visibleParts
        // (D6) so bearingVisibleTokenized (Solution) tokenizes it along with the rest of this
        // response's visible text, not just its char length.
        if (typeof raw.thinking === 'string' && raw.thinking.trim() !== '') {
          thinkingChars += raw.thinking.length;
          visibleParts.push(raw.thinking);
        }
      }
    }
    responses.push({
      messageId,
      outputTokens: group.outputTokens,
      thinkingBearing,
      visibleChars,
      thinkingChars,
      visibleText: visibleParts.join('\n'),
    });
  }
  return responses;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read one run's NDJSON off disk and meter it. Streams line by line rather than
 * `readFileSync` + `split` — a busy run's log is megabytes (`ec6e8e06` is 2.4 MB / 2 004 events)
 * and this is the same reason `runs/event-history.ts` streams.
 *
 * Malformed lines are skipped, not fatal: a log truncated mid-write by a killed process is a
 * normal thing to want stats for.
 *
 * **Filesystem reads beyond the NDJSON**, since Phase 2's calibrated mode (D3/D4): every distinct
 * `sessionId` the run's `session.started` events name gets a best-effort join against its Claude
 * Code session transcript (`~/.claude/projects/*&#47;<sessionId>.jsonl`) — missing, unreadable, or
 * unparseable transcripts degrade that session to no calibrated data silently, never fail the
 * whole read (the same posture already applied to a malformed NDJSON line above).
 *
 * **The lazy `import('gpt-tokenizer')` is Risk R8/R10's named seam.** This is the one path that
 * needs the tokenizer, so this is the one path that pays for loading it — `cez run stats` and
 * nothing else. `computeRunStats` itself stays synchronous and importable everywhere without
 * ever pulling the dependency in.
 */
export async function readRunStats(ndjsonPath: string, runId: string): Promise<RunStats> {
  const events: RunEvent[] = [];
  const lines = createInterface({ input: createReadStream(ndjsonPath, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line) as Partial<RunEvent>;
      if (typeof value.seq === 'number' && typeof value.type === 'string' && typeof value.ts === 'string') {
        events.push(value as RunEvent);
      }
    } catch {
      // Truncated or corrupt line — skip it, keep metering the rest.
    }
  }

  const sessionIds = new Set<string>();
  for (const event of events) {
    const started = sessionStartedOf(event);
    if (started) sessionIds.add(started.sessionId);
  }
  const transcripts = new Map<string, TranscriptResponse[]>();
  for (const sessionId of sessionIds) {
    if (!validSessionId(sessionId)) continue;
    const path = await findTranscriptPath(sessionId);
    if (!path) continue; // pruned, never captured, or an unexpected sessionId shape — basic mode
    try {
      const contents = await readFile(path, 'utf8');
      transcripts.set(sessionId, parseTranscriptResponses(contents.split('\n')));
    } catch {
      // Unreadable/corrupt transcript file — degrade this session to no calibrated data.
    }
  }

  const { countTokens } = await import('gpt-tokenizer');
  return computeRunStats(runId, events, transcripts.size > 0 ? transcripts : undefined, (text) => countTokens(text));
}

function secs(ms: number): string {
  return (ms / 1_000).toFixed(1);
}

/** Thousands of tokens, or an em dash for a step that never emitted a sample. Never `0.0`. */
function ktok(tokens: number | undefined): string {
  return tokens === undefined ? '—' : (tokens / 1_000).toFixed(1);
}

function pad(value: string, width: number, right = true): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

/** Thousands of characters, with the heredoc share beside it — `0.0k` for a step that emitted no
 *  tool-call input, never blank. */
function charsK(chars: number, heredocChars: number): string {
  const pct = chars > 0 ? ` (${Math.round((heredocChars / chars) * 100)}%)` : '';
  return `${(chars / 1_000).toFixed(1)}k${pct}`;
}

/**
 * The human table — the same shape as the per-step table in the spec's Problem section, so a
 * before/after pair can be read side by side without arithmetic.
 *
 * `calls` is the step's OWN calls, with the children's beside it in `child`, so the row reads as
 * what this step's agent spent. `ctx k` is peak context in thousands of tokens; on the TOTAL row
 * it is the max across steps, not a sum (see {@link RunStats.totals}).
 */
export function formatRunStats(stats: RunStats): string {
  const header = [
    pad('step', 16, false),
    pad('calls', 6),
    pad('child', 6),
    pad('trips', 6),
    pad('batch', 6),
    pad('model s', 9),
    pad('exec s', 9),
    pad('wall s', 9),
    pad('cheap', 6),
    pad('cheap s', 8),
    pad('sub', 4),
    pad('ctx k', 8),
    // `blind/total`, in one cell: the defect number is useless without the legitimate one beside
    // it, since a bounded poll loop is supposed to show up here.
    pad('sleep', 8),
    pad('re-run', 7),
    pad('chars k', 14),
  ].join('');

  const row = (label: string, s: Omit<StepStats, 'stepId' | 'restarts'>, restarts = 0): string =>
    [
      pad(restarts > 0 ? `${label} (×${restarts + 1})` : label, 16, false),
      pad(String(s.ownToolCalls), 6),
      pad(String(s.childToolCalls), 6),
      pad(String(s.roundTrips), 6),
      pad(s.batchFactor.toFixed(2), 6),
      pad(secs(s.modelMs), 9),
      pad(secs(s.toolExecMs), 9),
      pad(secs(s.wallMs), 9),
      pad(String(s.cheapCalls), 6),
      pad(secs(s.cheapExecMs), 8),
      pad(String(s.subAgentCalls), 4),
      pad(ktok(s.peakContextTokens), 8),
      pad(`${s.blindSleepCalls}/${s.sleepCalls}`, 8),
      pad(String(s.repeatedExpensiveCalls), 7),
      pad(charsK(s.toolInputChars, s.heredocChars), 14),
    ].join('');

  const lines = [
    `run ${stats.runId} — span ${secs(stats.spanMs)}s`,
    '',
    header,
    '-'.repeat(header.length),
    ...stats.steps.map((s) => row(s.stepId, s, s.restarts)),
    '-'.repeat(header.length),
    row('TOTAL', stats.totals),
    '',
    // The two numbers the spec is actually about, spelled out rather than left to be derived.
    `batch factor ${stats.totals.batchFactor.toFixed(2)} calls/round-trip` +
      (stats.totals.batchFactor > 0 && stats.totals.batchFactor < 1.05 ? '  (1.00 = never batched)' : ''),
    `model:exec ${stats.totals.toolExecMs > 0 ? (stats.totals.modelMs / stats.totals.toolExecMs).toFixed(1) : '—'}×` +
      ` · ${stats.totals.cheapCalls} cheap calls did ${secs(stats.totals.cheapExecMs)}s of work` +
      ` · ${stats.totals.subAgentCalls} sub-agent call(s)`,
    // Fan-out's whole point: the exploration output stayed in the child's window, not the parent's.
    `${stats.totals.childToolCalls} of ${stats.totals.toolCalls} calls were made by sub-agents` +
      ` · peak context ` +
      (stats.totals.peakContextTokens === undefined
        ? 'not sampled by this run'
        : `${ktok(stats.totals.peakContextTokens)}k (max over steps, never a sum)`),
    // Spelled out because both numbers are crude and neither should be read as a verdict on its
    // own: the target is `blind 0`, and `re-run` is a prompt to go read the commands.
    `sleep ${stats.totals.blindSleepCalls} blind of ${stats.totals.sleepCalls}` +
      ` (${secs(stats.totals.sleepExecMs)}s waited)` +
      (stats.totals.blindSleepCalls > 0 ? '  (blind = a guessed duration; target 0)' : '') +
      ` · ${stats.totals.repeatedExpensiveCalls} expensive call(s) re-run`,
    ...tokenBreakdownLines(stats),
    // The waste leads — it is the only one of these that is a defect on its own; a legitimate
    // near-total rewrite scores ≈ 0 on it (spec `heredocRewriteWasteChars`).
    `${(stats.totals.heredocRewriteWasteChars / 1_000).toFixed(1)}k chars re-emitted for nothing` +
      `  (${stats.totals.heredocFileWrites} file-authoring heredocs, ${stats.totals.heredocRewrites} of them re-emissions)`,
    ` · ${(stats.totals.heredocChars / 1_000).toFixed(1)}k of ${(stats.totals.toolInputChars / 1_000).toFixed(1)}k tool-call input chars were heredoc bodies` +
      (stats.totals.toolInputChars > 0
        ? ` (${((stats.totals.heredocChars / stats.totals.toolInputChars) * 100).toFixed(1)}%)`
        : ''),
  ];
  return lines.join('\n');
}

/** Thousands of tokens with a trailing `k`, or an em dash when there is nothing to show (no
 *  breakdown at all, or the field is `undefined` in this step's mode) — mirrors `ktok`. */
function tokk(tokens: number | undefined): string {
  return tokens === undefined ? '—' : `${(tokens / 1_000).toFixed(1)}k`;
}

/**
 * Per-step annotation lines below the breakdown table — the fields that don't fit a fixed table
 * column because their MEANING depends on `mode` (Phase 3, N8: an `'unavailable'` step gets its
 * own branch rather than a row of fake zeros).
 */
function tokenBreakdownAnnotations(label: string, tb: TokenBreakdown | undefined): string[] {
  if (!tb) return [];
  if (tb.mode === 'unavailable') {
    return [`  ${label}: breakdown unavailable — no tool/message events or transcript for this step`];
  }
  const lines: string[] = [];
  if (tb.mode === 'basic' && tb.unclassifiedGapTokens !== undefined) {
    lines.push(`  ${label}: ${tokk(tb.unclassifiedGapTokens)} tokens unattributed`);
  }
  if (tb.mode === 'calibrated') {
    // D6, this revision: the headline figures are the CALIBRATED categories — on the same
    // billed-token scale as withheldThinkingTokens/reportedTokens — printed with the raw
    // (unscaled) table figures and the run-wide factor alongside, never the raw figure alone,
    // unlabeled, beside a scaled withheldThinkingTokens (the defect this revision fixes).
    if (tb.calibratedMeasuredTokens !== undefined) {
      const factor = tb.calibration?.appliedScaleFactor;
      lines.push(
        `  ${label}: calibrated narrate/think/tool-arg ` +
          `${tokk(tb.calibratedNarrationTokens)}/${tokk(tb.calibratedThinkingTokens)}/${tokk(tb.calibratedToolArgTokens)}` +
          ` (raw ${tokk(tb.narrationTokens)}/${tokk(tb.thinkingTokens)}/${tokk(tb.toolArgTokens)}` +
          (factor !== undefined ? ` × ${factor.toFixed(3)}` : '') +
          `)`,
      );
    }
    if (tb.withheldThinkingTokens !== undefined) {
      lines.push(
        `  ${label}: ${tokk(tb.withheldThinkingTokens)} tokens withheld thinking (inferred)` +
          // calibratedResidual is a per-step calibration-fit diagnostic, not a tolerance-tested
          // reconciliation figure (D7) — it closes to ~0 only in aggregate, across the whole run.
          (tb.calibratedResidual !== undefined ? `, ${tokk(tb.calibratedResidual)} residual (fit diagnostic)` : '') +
          (tb.freeGapPct !== undefined ? `, freeGapPct ${tb.freeGapPct.toFixed(1)}%` : ''),
      );
    }
    // N7: printed only when THIS step's own local ratio is defined — never NaN.
    if (tb.calibration?.ratio !== undefined) {
      lines.push(
        `  ${label}: calibration ratio ${tb.calibration.ratio.toFixed(3)} chars/token` +
          ` (local, n=${tb.calibration.freeResponseCount})` +
          (tb.calibration.appliedRatio !== undefined ? ` — ${tb.calibration.appliedRatio.toFixed(3)} applied (run-wide)` : ''),
      );
    }
  }
  if (tb.childToolArgTokens !== undefined && tb.childToolArgTokens > 0) {
    lines.push(`  ${label}: ${tokk(tb.childToolArgTokens)} tokens unbilled to this step (sub-agent tool args)`);
  }
  // N2: printed only when defined AND > 0 — never a `0` line when blockCounts was unavailable.
  if (tb.opaqueBlocks !== undefined && tb.opaqueBlocks > 0) {
    lines.push(`  ${label}: ${tb.opaqueBlocks} opaque block(s) (redacted_thinking/server_tool_use/other)`);
  }
  return lines;
}

/**
 * The output-token breakdown block (Phase 3, `.ai/specs/2026-08-21-output-token-attribution.md`)
 * — printed only when at least one step has a `tokenBreakdown` at all (`stats.totals.tokenBreakdown`
 * defined); silently omitted otherwise, e.g. a run with no `turn.completed` events anywhere.
 * `thinkingTokens` prints as a plain measured figure, never qualified "inferred" (D1) —
 * `withheldThinkingTokens`, printed separately below the table, always carries that qualifier (R2).
 */
function tokenBreakdownLines(stats: RunStats): string[] {
  const totalTb = stats.totals.tokenBreakdown;
  if (!totalTb) return [];

  const header = [
    pad('step', 16, false),
    pad('reported', 9),
    pad('narrate', 9),
    pad('think', 9),
    pad('tool-arg', 9),
    pad('child', 9),
    pad('measured', 9),
    pad('mode', 11),
  ].join('');

  const row = (label: string, tb: TokenBreakdown | undefined): string =>
    [
      pad(label, 16, false),
      pad(tokk(tb?.reportedTokens), 9),
      pad(tokk(tb?.narrationTokens), 9),
      pad(tokk(tb?.thinkingTokens), 9),
      pad(tokk(tb?.toolArgTokens), 9),
      pad(tokk(tb?.childToolArgTokens), 9),
      pad(tokk(tb?.measuredTokens), 9),
      pad(tb?.mode ?? '—', 11),
    ].join('');

  return [
    '',
    'output tokens — where they went (narration/thinking/tool-arg are measured; unbilled/withheld/unattributed reported below, separately)',
    header,
    '-'.repeat(header.length),
    ...stats.steps.map((s) => row(s.stepId, s.tokenBreakdown)),
    '-'.repeat(header.length),
    row('TOTAL', totalTb),
    ...stats.steps.flatMap((s) => tokenBreakdownAnnotations(s.stepId, s.tokenBreakdown)),
    ...tokenBreakdownAnnotations('TOTAL', totalTb),
    ...(totalTb.stepsWithoutBlockCounts
      ? [
          `  (${totalTb.stepsWithoutBlockCounts} step(s) missing blockCounts — TOTAL opaqueBlocks excludes them, "unknown" not "confirmed zero")`,
        ]
      : []),
    ...(totalTb.stepsNotCalibrated
      ? [`  (${totalTb.stepsNotCalibrated} step(s) not calibrated — TOTAL withheldThinkingTokens/calibratedResidual exclude them)`]
      : []),
  ];
}
