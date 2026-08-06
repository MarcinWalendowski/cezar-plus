import { readCatalog, readManifest } from './catalog.ts';

/**
 * The agent-facing READ half of the knowledge base (W4.2). See
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` ("Agent read path and write back") and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` (D1..D25, outranks the spec on conflict).
 *
 * Deliberately reads the PERSISTED catalog cache (`knowledge/catalog.ts`'s NDJSON + manifest)
 * rather than taking a live `KnowledgeStore` reference: `RunManager` (`workflows/run.ts`) only
 * ever has `dataDir`/`repoRoot`, never a handle onto the per-project store `ProjectContext`
 * (W3.1) builds — and the cache the live store maintains is exactly "the store" this module needs
 * to summarize. `loadKnowledgeSummary` is therefore zero-I/O when `CEZ_KB` is off (D4) and, when
 * on, does two cheap file reads instead of a live corpus scan.
 */

// ---- summary (pure data, no document body/excerpt/title/slug ever reaches this shape) ---------

export interface KnowledgePromptRoot {
  id: string;
  path: string;
  documentCount: number;
}

export interface KnowledgePromptSummary {
  roots: KnowledgePromptRoot[];
  totalDocuments: number;
  /** Distinct `type` values in use — always one of the closed `knowledgeDocTypeSchema` enum
   *  members, so this carries no unsanitized document-derived text (Q12). */
  types: string[];
  /** At most 40, each already checked against `KNOWLEDGE_TAG_RE` (Q12). */
  tags: Array<{ value: string; count: number }>;
}

/** `/^[a-z0-9][a-z0-9 _-]{0,31}$/` (Q12) — the entire document-derived surface of the prompt block
 *  is bounded by this: no punctuation, no URL, no newline, no code. A tag that does not match this
 *  in full is dropped, never truncated or partially admitted. */
export const KNOWLEDGE_TAG_RE = /^[a-z0-9][a-z0-9 _-]{0,31}$/;

const MAX_PROMPT_TAGS = 40;

/**
 * Loads the summary a system-prompt block (or the `CEZ_KB_ROOTS` env var) is built from.
 * `undefined` whenever `CEZ_KB` is not exactly `'1'` (zero I/O, D4) OR the store has never
 * completed a reindex yet (no manifest and no catalog — a still-warming store legitimately has
 * nothing to report; this self-heals the moment the first reindex persists).
 *
 * Note this does NOT gate on document count — a project with an empty (but resolved) `project`
 * root still gets its root paths reported here, because `CEZ_KB_ROOTS`/`additionalDirectories`
 * need the paths regardless of whether anything is indexed there yet. `knowledgeSystemPrompt`
 * below is what applies the additional "at least one document" gate for the TEXT block only.
 */
export async function loadKnowledgeSummary(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KnowledgePromptSummary | undefined> {
  if (env.CEZ_KB !== '1') return undefined;

  const [manifest, catalog] = await Promise.all([readManifest(dataDir), readCatalog(dataDir)]);
  if (!manifest && (!catalog || catalog.length === 0)) return undefined;

  const entries = catalog ?? [];
  const countsByRoot = new Map<string, number>();
  const typesSeen = new Set<string>();
  const tagCounts = new Map<string, number>();
  for (const entry of entries) {
    countsByRoot.set(entry.root, (countsByRoot.get(entry.root) ?? 0) + 1);
    typesSeen.add(entry.type);
    for (const tag of entry.tags) {
      if (!KNOWLEDGE_TAG_RE.test(tag)) continue;
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const roots: KnowledgePromptRoot[] = (manifest?.roots ?? []).map((r) => ({
    id: r.id,
    path: r.path,
    documentCount: countsByRoot.get(r.id) ?? 0,
  }));

  const tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_PROMPT_TAGS)
    .map(([value, count]) => ({ value, count }));

  return {
    roots,
    totalDocuments: entries.length,
    types: [...typesSeen].sort(),
    tags,
  };
}

// ---- the prompt block itself --------------------------------------------------------------

const CLI_SEARCH_LINE = 'cez kb search "<query>"';
const CLI_SHOW_LINE = 'cez kb show <id>';

/**
 * `knowledgeSystemPrompt(summary)` returns `undefined` unless the store holds at least one
 * indexed document — combined with `loadKnowledgeSummary`'s own `CEZ_KB==='1'` gate, that is
 * "unless `CEZ_KB === '1'` and the store holds at least one indexed document" end to end
 * (spec, "Agent read path and write back"). `composeSystemPrompt` (`workflows/run.ts`) drops
 * blank parts, so `undefined` here means the composed prompt is byte-identical to before this
 * feature existed (C6).
 *
 * What this emits: document counts (per root and total), the absolute path of each root, at
 * most 40 sanitized tag tokens with counts, the type names in use, the two literal CLI
 * invocations, and the write-back proposal protocol. What it NEVER emits: a body, an excerpt, a
 * title, a slug, a filename, a heading — mounts point at directories this feature does not own,
 * so any string lifted out of a mounted document into a system prompt is a prompt-injection
 * channel (Q12), and tags are re-filtered against `KNOWLEDGE_TAG_RE` here too (defense in depth:
 * this function is pure and must hold its own contract regardless of what a caller builds).
 */
export function knowledgeSystemPrompt(summary: KnowledgePromptSummary | undefined): string | undefined {
  if (!summary || summary.totalDocuments < 1) return undefined;

  const safeTags = summary.tags.filter((t) => KNOWLEDGE_TAG_RE.test(t.value)).slice(0, MAX_PROMPT_TAGS);

  const rootLines = summary.roots
    .map((r) => `- ${r.id}: ${r.path} (${r.documentCount} doc${r.documentCount === 1 ? '' : 's'})`)
    .join('\n');
  const tagLine = safeTags.length ? safeTags.map((t) => `${t.value} (${t.count})`).join(', ') : '(none)';
  const typeLine = summary.types.length ? summary.types.join(', ') : '(none)';

  return [
    '## Knowledge base (cezar)',
    '',
    `${summary.totalDocuments} document${summary.totalDocuments === 1 ? '' : 's'} indexed across ` +
      `${summary.roots.length} root${summary.roots.length === 1 ? '' : 's'}:`,
    rootLines,
    '',
    `Types in use: ${typeLine}`,
    `Common tags: ${tagLine}`,
    '',
    'Search before assuming something is undocumented — this is a lexical match, not proof of',
    'absence:',
    `  ${CLI_SEARCH_LINE}`,
    `  ${CLI_SHOW_LINE}`,
    '',
    'To record a durable decision, or correct a stale one, append NDJSON lines to',
    'CEZ_KB_WRITE_FILE (env) — never edit a mounted document directly. Each line needs its own',
    '"seq" (an integer, starting at 0 and counting up across every line you append to this file',
    'this run — read the file first if it already has lines from an earlier turn), "runId" (this',
    'run\'s id, i.e. CEZ_TASK_ID), and "createdAt" (an ISO-8601 timestamp), plus one of:',
    '  {"op":"upsert","scope":"project"|"workspace","path":"...","title":"...","type":"...",',
    '   "tags":["..."],"supersedes":["..."],"body":"...","seq":0,"runId":"...","createdAt":"..."}',
    '  {"op":"supersede","target":"<id-or-slug>","by":"<id-or-slug>","date":"YYYY-MM-DD",',
    '   "note":"...","amendHeading":false,"seq":1,"runId":"...","createdAt":"..."}',
    'A proposal is reviewed and applied later, through the cockpit or `cez kb proposals` — never',
    'automatically.',
  ].join('\n');
}
