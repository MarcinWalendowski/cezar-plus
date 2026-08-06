/**
 * The knowledge base link graph (F1, W1.3). `[[wikilink]]` extraction plus explicit frontmatter
 * `links[]`, three-tier resolution (id, then slug, then filename stem, case insensitive), and the
 * reverse backlink index. A pure function module over a catalog array, no filesystem and no I/O,
 * so it unit tests standalone and runs in parallel with the format adapters (W1.2) rather than
 * behind them. See `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` ("Search and the link
 * graph") and `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` for the decisions (D1..D25) that
 * outrank the spec on any conflict.
 *
 * An unresolved link is REPORTED, `{resolved:false}`, never dropped: a hidden broken link is a
 * lie about the graph. More than one candidate at a resolution tier is
 * `{resolved:false, reason:'ambiguous', candidates:[...]}`, never a silent pick (C12).
 *
 * The generic type parameter is deliberate: this file owns no shared `types.ts` (that is W2.1's,
 * built later), so it names the minimal shape it needs and lets any richer catalog-entry type
 * satisfy it structurally. `id`, `slug` and `path` mirror the wire `KnowledgeDocument` shape in
 * `packages/contract/src/knowledge.ts` (already scaffolded by W1.1).
 */

export interface LinkableDocument {
  readonly id: string;
  /** Human name. NOT unique (Q7) - a wikilink resolving to more than one slug is ambiguous. */
  readonly slug: string;
  readonly path: string;
  readonly body: string;
  /** Explicit frontmatter `links[]`: raw target strings, unioned with `[[wikilink]]` targets
   *  extracted from `body`. */
  readonly links?: readonly string[];
}

export interface ResolvedLink {
  target: string;
  resolved: boolean;
  id?: string;
  reason?: string;
  candidates?: string[];
}

export interface LinkGraph {
  /** Every document's own (resolved-or-not) outbound links, keyed by doc id. */
  linksByDoc: Map<string, ResolvedLink[]>;
  /** Reverse index: doc id -> the ids of documents whose resolved links point at it. */
  backlinksByDoc: Map<string, string[]>;
  /** The stable derived integer the catalog carries as `backlinkCount`. */
  backlinkCounts: Map<string, number>;
}

// `[[target]]` or `[[target|Display text]]` - the pipe splits a display label from the target,
// the common wikilink convention. Anything before the first `]]` that isn't a `]` itself.
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** Extracts raw `[[wikilink]]` targets from a document body, in order of first appearance,
 *  trimmed and with any `|Display text` suffix stripped. Never resolves them - resolution needs
 *  the whole corpus. */
export function extractWikilinkTargets(body: string): string[] {
  const targets: string[] = [];
  const re = new RegExp(WIKILINK_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const inner = m[1] ?? '';
    const target = (inner.split('|', 1)[0] ?? '').trim();
    if (target) targets.push(target);
  }
  return targets;
}

function filenameStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Three-tier resolution, case insensitive throughout: exact `id`, then exact `slug`, then
 * filename stem. A tier that matches more than one document stops there and reports it
 * ambiguous rather than falling through to a later tier - the later tier did not fail, the
 * earlier one over-matched, and falling through would silently paper over that.
 */
export function resolveLinkTarget<T extends LinkableDocument>(
  target: string,
  allDocs: readonly T[],
): ResolvedLink {
  const needle = target.trim().toLowerCase();
  if (!needle) return { target, resolved: false };

  const tiers: Array<(doc: T) => string> = [
    (doc) => doc.id,
    (doc) => doc.slug,
    (doc) => filenameStem(doc.path),
  ];

  for (const keyOf of tiers) {
    const matches = allDocs.filter((doc) => keyOf(doc).toLowerCase() === needle);
    if (matches.length === 1) return { target, resolved: true, id: matches[0]!.id };
    if (matches.length > 1) {
      return {
        target,
        resolved: false,
        reason: 'ambiguous',
        candidates: matches.map((doc) => doc.id),
      };
    }
  }

  return { target, resolved: false };
}

/** Explicit frontmatter `links[]` unioned with `[[wikilink]]` targets found in the body,
 *  deduplicated case insensitively (first occurrence wins the display casing), each resolved
 *  independently. */
export function resolveDocumentLinks<T extends LinkableDocument>(
  doc: T,
  allDocs: readonly T[],
): ResolvedLink[] {
  const explicit = doc.links ?? [];
  const wiki = extractWikilinkTargets(doc.body);
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const raw of [...explicit, ...wiki]) {
    const trimmed = raw.trim();
    const key = trimmed.toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      targets.push(trimmed);
    }
  }
  return targets.map((t) => resolveLinkTarget(t, allDocs));
}

/**
 * Builds the whole corpus's link graph in one pass: every document's resolved outbound links,
 * plus the reverse backlink index and its stable derived count. Only a resolved link
 * contributes to a backlink - an unresolved or ambiguous target names no document to point at.
 */
export function buildLinkGraph<T extends LinkableDocument>(docs: readonly T[]): LinkGraph {
  const linksByDoc = new Map<string, ResolvedLink[]>();
  const backlinksByDoc = new Map<string, string[]>();

  for (const doc of docs) {
    const links = resolveDocumentLinks(doc, docs);
    linksByDoc.set(doc.id, links);
    for (const link of links) {
      if (!link.resolved || !link.id) continue;
      const sources = backlinksByDoc.get(link.id) ?? [];
      if (!sources.includes(doc.id)) sources.push(doc.id);
      backlinksByDoc.set(link.id, sources);
    }
  }

  const backlinkCounts = new Map<string, number>();
  for (const doc of docs) backlinkCounts.set(doc.id, backlinksByDoc.get(doc.id)?.length ?? 0);

  return { linksByDoc, backlinksByDoc, backlinkCounts };
}
