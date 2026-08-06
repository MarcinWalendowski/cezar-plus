import {
  knowledgeDocTypeSchema,
  knowledgeSourceSchema,
  type KnowledgeDocType,
  type KnowledgeSource,
  type KnowledgeStatus,
} from '@open-mercato/cezar-contract';
import { resolveKnowledgeFormat, runFormatAdapter, type KnowledgeFormat } from './adapters.ts';

/**
 * The pure format-adapter entry point (W1.2). See
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` ("Format adapters") and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` Q10/D2.
 *
 * `parseDocument(raw, path, format)` never throws and never refuses to index a document: an
 * adapter degrades tolerantly (see `adapters.ts`), and every field derived here falls back to a
 * documented default rather than failing the whole parse. This file owns the normalization that
 * is the SAME across all four formats — title fallback, type/status fallback with the fixed
 * status precedence, and coercing frontmatter values into the well-known fields — so an adapter
 * only has to answer "where does the metadata block end" for its own shape.
 *
 * `ParsedDoc` is intentionally close to (but not identical to) the wire `KnowledgeDocument`
 * (`packages/contract/src/knowledge.ts`): it carries everything a document's own bytes can
 * answer — no `id`, `slug`, `root`, `hash`, `bytes`, `headings`, `excerpt`, `backlinkCount` or
 * resolved `links[]`, because those all need context (a root, a catalog, a link graph) this pure
 * function does not have. `knowledge/catalog.ts` (W2.1) assembles the rest around this.
 */

export interface ParsedDoc {
  format: KnowledgeFormat;
  title: string;
  type: KnowledgeDocType;
  tags: string[];
  /** Absent means workspace-wide. */
  project?: string;
  status: KnowledgeStatus;
  /** The original status string, kept verbatim even once normalized into `status`. Absent when
   *  no status was found at all (not even an unrecognised one). */
  statusRaw?: string;
  supersedes?: string[];
  supersededBy?: string;
  supersededAt?: string;
  /** SECONDARY, NON-UNIQUE index — the explicit frontmatter list only. The body/heading regex
   *  scan that unions with this is `knowledge/search.ts` (W1.3), over the built catalog. */
  identifiers: string[];
  /** Present only when frontmatter carried a `source` object that matched the wire shape
   *  (Q15/D17). A present-but-invalid `source` is dropped with a warning, never fatal. */
  source?: KnowledgeSource;
  /** `undefined` when frontmatter had no `updatedAt`. This function does no I/O, so the file
   *  mtime fallback described in the spec is applied by the caller (`knowledge/catalog.ts`). */
  updatedAt?: string;
  /** Explicit frontmatter `links[]` only. `[[wikilink]]` extraction from `body` is
   *  `knowledge/links.ts` (W1.3), over the built catalog. */
  links?: string[];
  /** The document body. For `markdown`/`strict-frontmatter` this is everything after the YAML
   *  frontmatter fence (or the whole file, when no fence was found). For `bullet-meta`/
   *  `line-meta` this is the WHOLE file, unmodified: their leading block is ordinary rendered
   *  Markdown a reader expects to still see, not a hidden metadata section — see
   *  `adapters.ts`'s `headerBlockAdapter` comment. */
  body: string;
  /** Every non-fatal degradation encountered while parsing this document. Never empty just
   *  because nothing was found — only when something recognisable failed to parse. */
  warnings: string[];
}

export function parseDocument(raw: string, path: string, format?: string): ParsedDoc {
  const resolvedFormat = resolveKnowledgeFormat(format);
  const { frontmatter, body, warnings } = runFormatAdapter(raw, path, format);
  const allWarnings = [...warnings];

  const { status, statusRaw } = normalizeStatus(coerceString(frontmatter.status));
  const source = resolveSource(frontmatter.source, allWarnings);
  const supersedes = toStringArray(frontmatter.supersedes);
  const links = toStringArray(frontmatter.links);

  return {
    format: resolvedFormat,
    title: resolveTitle(frontmatter, body, path),
    type: resolveType(resolveTypeValue(frontmatter)),
    tags: toStringArray(frontmatter.tags),
    project: coerceString(frontmatter.project),
    status,
    statusRaw,
    supersedes: supersedes.length ? supersedes : undefined,
    supersededBy: coerceString(frontmatter.supersededBy ?? frontmatter['superseded_by']),
    supersededAt: coerceString(frontmatter.supersededAt ?? frontmatter['superseded_at']),
    identifiers: toStringArray(frontmatter.identifiers),
    source,
    updatedAt: coerceString(frontmatter.updatedAt ?? frontmatter['updated_at']),
    links: links.length ? links : undefined,
    body,
    warnings: allWarnings,
  };
}

// ---- title -----------------------------------------------------------------------------------

const H1_RE = /^#\s+(.+?)\s*$/;

/** frontmatter.title, then frontmatter.name (the `strict-frontmatter` memory-note shape keys a
 *  document by `name`, not `title`), then the first H1 in the body, then the filename stem. */
function resolveTitle(frontmatter: Record<string, unknown>, body: string, path: string): string {
  const explicit = coerceString(frontmatter.title) ?? coerceString(frontmatter.name);
  if (explicit && explicit.trim()) return explicit.trim();
  const h1 = extractFirstH1(body);
  if (h1) return h1;
  return filenameStem(path);
}

function extractFirstH1(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const match = H1_RE.exec(line);
    if (match) return match[1]!.trim();
  }
  return undefined;
}

function filenameStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// ---- type ------------------------------------------------------------------------------------

/** `type` at the top level, or `metadata.type` (the `strict-frontmatter` memory-note shape nests
 *  it there). Unknown falls back to `note` in `resolveType`. */
function resolveTypeValue(frontmatter: Record<string, unknown>): unknown {
  if (frontmatter.type !== undefined) return frontmatter.type;
  const metadata = frontmatter.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return (metadata as Record<string, unknown>).type;
  }
  return undefined;
}

function resolveType(value: unknown): KnowledgeDocType {
  const raw = coerceString(value)?.trim().toLowerCase();
  const parsed = knowledgeDocTypeSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'note';
}

// ---- status ----------------------------------------------------------------------------------
//
// A generic lifecycle vocabulary, not a hardcoded table of one workspace's spellings (D2).
// Precedence is load-bearing: "Superseded by X (was Implemented)" must read as superseded, so
// every family is checked in this fixed order and the first match wins, regardless of where in
// the string it appears.

const STATUS_FAMILIES: ReadonlyArray<{ status: KnowledgeStatus; keywords: readonly string[] }> = [
  { status: 'superseded', keywords: ['superseded', 'replaced', 'obsolete', 'deprecated'] },
  { status: 'current', keywords: ['implemented', 'done', 'shipped', 'complete', 'partial'] },
  { status: 'draft', keywords: ['proposed', 'draft', 'wip', 'planned'] },
];

function normalizeStatus(raw: string | undefined): { status: KnowledgeStatus; statusRaw?: string } {
  const trimmed = raw?.trim();
  if (!trimmed) return { status: 'current' };
  for (const family of STATUS_FAMILIES) {
    if (family.keywords.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(trimmed))) {
      return { status: family.status, statusRaw: trimmed };
    }
  }
  return { status: 'current', statusRaw: trimmed };
}

// ---- source ------------------------------------------------------------------------------------

/** Storage schemas are `.passthrough()` and additive-only (Q15), but this is exactly the seam
 *  that needs more than that: a `source` block that does not match the wire shape would otherwise
 *  survive the file and silently vanish at the catalog/API boundary, which is precisely the
 *  conflict signal (`source.state`) F2 exists to produce. So it is validated here, once, and
 *  dropped with a warning rather than carried through malformed. */
function resolveSource(value: unknown, warnings: string[]): KnowledgeSource | undefined {
  if (value === undefined) return undefined;
  const parsed = knowledgeSourceSchema.safeParse(value);
  if (!parsed.success) {
    warnings.push('frontmatter "source" did not match the expected shape, ignoring');
    return undefined;
  }
  return parsed.data;
}

// ---- coercion helpers --------------------------------------------------------------------------

function coerceString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

/** Accepts a real array (YAML `tags: [a, b]`) or a free-text string (a `bullet-meta`/`line-meta`
 *  value, or a stray YAML scalar) — `"[a, b]"` or `"a, b"` both split into `['a', 'b']`. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => coerceString(entry)).filter((entry): entry is string => !!entry && entry.length > 0);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
    return inner
      .split(',')
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
      .filter((entry) => entry.length > 0);
  }
  return [];
}
