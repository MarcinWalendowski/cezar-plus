import { parse as parseYaml } from 'yaml';

/**
 * Format adapters (W1.2). See `.ai/specs/2026-08-06-knowledge-base-mounts-search.md`
 * ("Format adapters") and `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` Q10 for the naming:
 * the brief's per-workspace format names are renamed here to the generic shapes they actually
 * parse, so no workspace or product name ever enters this file (D2).
 *
 * Each adapter is a pure `(raw, path) => { frontmatter, body, warnings }` split. It never throws
 * and never refuses to index a document: an unrecognised or malformed leading block degrades to
 * an empty `frontmatter` with a warning, and `body` still carries the full document. `parse.ts`
 * takes this split and normalizes it into a `ParsedDoc` uniformly across all four formats.
 */

export const KNOWN_KNOWLEDGE_FORMATS = ['markdown', 'bullet-meta', 'line-meta', 'strict-frontmatter'] as const;
export type KnowledgeFormat = (typeof KNOWN_KNOWLEDGE_FORMATS)[number];

/** Unknown or absent format degrades to `markdown`, per the spec's format table. */
export function resolveKnowledgeFormat(format: string | undefined): KnowledgeFormat {
  return (KNOWN_KNOWLEDGE_FORMATS as readonly string[]).includes(format ?? '')
    ? (format as KnowledgeFormat)
    : 'markdown';
}

export interface AdapterResult {
  /** Extracted metadata, keys lower-cased. Never `.passthrough()`-validated here — `parse.ts`
   *  reads the well-known keys and keeps the whole object for downstream storage. */
  frontmatter: Record<string, unknown>;
  body: string;
  warnings: string[];
}

export type FormatAdapter = (raw: string, path: string) => AdapterResult;

// ---- shared line scanning --------------------------------------------------------------------

interface Line {
  /** Line content WITHOUT its trailing newline, used for matching. */
  text: string;
  /** Byte offset in the original `raw` string where the NEXT line starts (or `raw.length` for
   *  the last line). Only used if a future caller needs to slice by offset; kept for clarity. */
  end: number;
}

function scanLines(raw: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\n') {
      lines.push({ text: stripCr(raw.slice(start, i)), end: i + 1 });
      start = i + 1;
    }
  }
  if (start < raw.length) lines.push({ text: stripCr(raw.slice(start)), end: raw.length });
  return lines;
}

function stripCr(text: string): string {
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

const BLANK_RE = /^\s*$/;
const H1_RE = /^#\s+(.+?)\s*$/;

// ---- YAML frontmatter fence -------------------------------------------------------------------

/** `---\n...\n---` at the very start of the file. Anchored to position 0 (no `m` flag) so a
 *  `---` horizontal rule later in the document is never mistaken for a fence. */
const FRONTMATTER_FENCE_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

interface FenceResult {
  /** `undefined` means no `---...---` fence was found at all (a legitimately bare document). */
  frontmatter: Record<string, unknown> | undefined;
  body: string;
  warning?: string;
}

function parseFrontmatterFence(raw: string): FenceResult {
  const match = FRONTMATTER_FENCE_RE.exec(raw);
  if (!match) return { frontmatter: undefined, body: raw };
  const body = raw.slice(match[0]!.length);
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? '');
  } catch (err) {
    return {
      frontmatter: {},
      body,
      warning: `frontmatter did not parse as YAML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed == null) return { frontmatter: {}, body };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { frontmatter: {}, body, warning: 'frontmatter did not parse to a mapping, ignoring' };
  }
  return { frontmatter: parsed as Record<string, unknown>, body };
}

/** `markdown` (default): frontmatter is fully optional. A bare `.md` is a valid document and
 *  produces no warning at all — that is the whole point of the format. */
const markdownAdapter: FormatAdapter = (raw) => {
  const result = parseFrontmatterFence(raw);
  return {
    frontmatter: result.frontmatter ?? {},
    body: result.body,
    warnings: result.warning ? [`markdown: ${result.warning}`] : [],
  };
};

/** `strict-frontmatter`: YAML frontmatter is required. Unlike `markdown`, a missing or malformed
 *  block is REPORTED (a warning is always added) rather than silently treated as a valid bare
 *  document — for a corpus that guarantees frontmatter, a regression there must be visible. It
 *  still never throws and still indexes the document with defaults (no field is ever fatal). */
const strictFrontmatterAdapter: FormatAdapter = (raw) => {
  const result = parseFrontmatterFence(raw);
  const warnings: string[] = [];
  if (result.frontmatter === undefined) {
    warnings.push('strict-frontmatter: no YAML frontmatter block found');
  } else if (result.warning) {
    warnings.push(`strict-frontmatter: ${result.warning}`);
  }
  return { frontmatter: result.frontmatter ?? {}, body: result.body, warnings };
};

// ---- leading header-block formats (bullet-meta, line-meta) --------------------------------

/**
 * `# Title` followed by a leading block of metadata lines matched by `metaLineRe`, which the
 * caller supplies per format. Recognising the block never removes it from `body`: unlike YAML
 * frontmatter, this metadata is ordinary rendered Markdown prose (bold bullets or plain lines)
 * that a reader of the raw file expects to still see, so `body` is always the full, untouched
 * `raw` text. Only the extracted `frontmatter` record is derived from it.
 */
function headerBlockAdapter(formatLabel: string, metaLineRe: RegExp): FormatAdapter {
  return (raw) => {
    const lines = scanLines(raw);
    let idx = 0;
    while (idx < lines.length && BLANK_RE.test(lines[idx]!.text)) idx++;

    let title: string | undefined;
    if (idx < lines.length) {
      const h1 = H1_RE.exec(lines[idx]!.text);
      if (h1) {
        title = h1[1]!.trim();
        idx++;
      }
    }
    while (idx < lines.length && BLANK_RE.test(lines[idx]!.text)) idx++;

    const frontmatter: Record<string, unknown> = {};
    while (idx < lines.length) {
      const m = metaLineRe.exec(lines[idx]!.text);
      if (!m) break;
      const key = m[1]!.trim().toLowerCase();
      const value = (m[2] ?? '').trim();
      if (frontmatter[key] === undefined) frontmatter[key] = value;
      idx++;
    }
    if (title && frontmatter.title === undefined) frontmatter.title = title;

    return { frontmatter, body: raw, warnings: [] };
  };
}

/** `# Title` then `- **Key:** value` bullets — the shape a spec written as prose metadata uses. */
const bulletMetaAdapter = headerBlockAdapter('bullet-meta', /^-\s+\*\*([^*:]+):\*\*\s?(.*)$/);

/** `# Title` then plain `Key: value` lines — the shape cezar's own specs and run plans use. */
const lineMetaAdapter = headerBlockAdapter('line-meta', /^([A-Za-z][A-Za-z0-9_-]{0,40}):\s+(.*)$/);

// ---- registry -----------------------------------------------------------------------------

export const FORMAT_ADAPTERS: Record<KnowledgeFormat, FormatAdapter> = {
  markdown: markdownAdapter,
  'bullet-meta': bulletMetaAdapter,
  'line-meta': lineMetaAdapter,
  'strict-frontmatter': strictFrontmatterAdapter,
};

/** Runs the adapter for `format` (unknown format falls back to `markdown`, see
 *  `resolveKnowledgeFormat`). This is the one entry point `parse.ts` calls. */
export function runFormatAdapter(raw: string, path: string, format: string | undefined): AdapterResult {
  const resolved = resolveKnowledgeFormat(format);
  return FORMAT_ADAPTERS[resolved](raw, path);
}
