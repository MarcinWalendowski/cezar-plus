import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { buildLinkGraph, type LinkableDocument, type ResolvedLink } from './links.ts';
import { parseDocument } from './parse.ts';
import { catalogPath, manifestPath, shouldSkipDir } from './paths.ts';
import {
  CATALOG_FORMAT_VERSION,
  SCAN_CAPS,
  catalogEntrySchema,
  emptyScanStats,
  knowledgeManifestSchema,
  type CatalogEntry,
  type KnowledgeManifest,
  type ResolvedKnowledgeRoot,
  type ScanStats,
} from './types.ts';

/**
 * The catalog cache: scan + parse + link-resolve a root list into `CatalogEntry` rows, plus the
 * NDJSON/manifest persistence for the O(changed) reindex (W2.1). Pure-ish: every function here
 * takes a root list and returns data: no watcher, no debounce, no orchestration — that is
 * `knowledge/store.ts`. See `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` ("Catalog cache")
 * and `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D1..D25.
 *
 * **Bodies are never in the catalog** (Data Models → "Catalog entry"): the persisted NDJSON line is
 * `CatalogEntry`, which has no `body`. This module still returns the parsed body alongside every
 * entry (`ParsedFile.body`) because `knowledge/store.ts` needs it in memory for search (BM25 scores
 * against body text) and for wikilink extraction — it is simply never serialized to disk here.
 */

const MD_RE = /\.(md|markdown)$/i;

export interface ScanCaps {
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
}

export const DEFAULT_SCAN_CAPS: ScanCaps = SCAN_CAPS;

export interface ParsedFile {
  entry: CatalogEntry;
  body: string;
  warnings: string[];
}

export interface BuildResult {
  documents: ParsedFile[];
  scan: ScanStats;
  idCollisions: number;
}

// ---- scanning -----------------------------------------------------------------------------

export interface ScannedFile {
  absPath: string;
  relPath: string;
  rootId: string;
  format: string | undefined;
  size: number;
  mtimeMs: number;
}

interface ScanAccumulator {
  files: ScannedFile[];
  stats: ScanStats;
}

async function walkDir(
  dirPath: string,
  root: ResolvedKnowledgeRoot,
  caps: ScanCaps,
  acc: ScanAccumulator,
): Promise<void> {
  if (acc.stats.truncated && acc.stats.capHit !== 'perFile') return;
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return; // unreadable directory — degrade quietly, not a hard failure
  }
  // Deterministic ordering (D8): two consecutive builds must walk files in the same order.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (acc.files.length >= caps.maxFiles) {
      acc.stats.truncated = true;
      acc.stats.capHit = 'files';
      return;
    }
    const abs = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(abs, entry.name)) continue;
      await walkDir(abs, root, caps, acc);
      if (acc.stats.capHit === 'files' || acc.stats.capHit === 'bytes') return;
      continue;
    }
    if (!entry.isFile()) continue;
    if (!MD_RE.test(entry.name)) continue;

    let info;
    try {
      info = await stat(abs);
    } catch {
      acc.stats.skipped++;
      continue;
    }
    if (info.size > caps.maxFileBytes) {
      // A single oversized file is skipped and counted — the corpus is truncated by exactly one
      // file, reported honestly rather than silently short (spec "Roots" / edge cases).
      acc.stats.skipped++;
      acc.stats.truncated = true;
      acc.stats.capHit = acc.stats.capHit ?? 'perFile';
      continue;
    }
    if (acc.stats.bytesScanned + info.size > caps.maxTotalBytes) {
      acc.stats.truncated = true;
      acc.stats.capHit = 'bytes';
      return;
    }
    acc.stats.bytesScanned += info.size;
    acc.stats.filesScanned++;
    acc.files.push({
      absPath: abs,
      relPath: relative(root.path, abs),
      rootId: root.id,
      format: root.format,
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
  }
}

/** Walk every indexed root, honoring the shared exclusion list and the global caps (they bind
 *  across the whole scan, not per root — one `GET /knowledge` reports one `scan` object). */
export async function scanRoots(
  roots: readonly ResolvedKnowledgeRoot[],
  caps: ScanCaps = DEFAULT_SCAN_CAPS,
): Promise<{ files: ScannedFile[]; stats: ScanStats }> {
  const acc: ScanAccumulator = { files: [], stats: emptyScanStats() };
  for (const root of roots) {
    if (!root.indexed) continue;
    await walkDir(root.path, root, caps, acc);
  }
  return { files: acc.files, stats: acc.stats };
}

// ---- parsing --------------------------------------------------------------------------------

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** `<rootId>-<first 12 hex of sha256(relPath)>` (Q7) — opaque, URL-segment safe by construction. */
function makeId(rootId: string, relPath: string): string {
  const digest = sha256(relPath).slice(0, 12);
  return `${rootId}-${digest}`;
}

function filenameStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

function extractHeadings(body: string): string[] {
  const headings: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = HEADING_RE.exec(line);
    if (match) headings.push(match[2]!.trim());
  }
  return headings;
}

const H1_RE = /^#\s+(.+?)\s*$/;

/**
 * Drop the leading `# Title` line once it has become the document's `title`.
 *
 * `parseDocument` deliberately leaves the body byte-identical to the file (its own header: "body
 * untouched") — it answers "what do these bytes say", and stripping there would make the parsed
 * body a lie about the file. The indexed body is the other thing: `headings` feeds the result row
 * under the title in the cockpit, and `excerpt` is the ~240 chars a reader sees next to it, so a
 * title carried in both slots is the same string printed twice with the first real heading pushed
 * out of view (spec "Catalog entry": `headings:["Problem","Solution"]` for a document whose H1 IS
 * its title).
 *
 * Only the document's OPENING heading, and only when it is verbatim the resolved title — a
 * frontmatter `title:` that disagrees with the H1, or an H1 further down after prose, is content
 * this must not delete. Bounded to the leading blank lines plus one, so the whole-corpus build
 * cost (C18's ms-per-MiB budget) does not grow with document length.
 */
function stripTitleHeading(body: string, title: string): string {
  let lineStart = 0;
  for (;;) {
    const newline = body.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? body.length : newline;
    const raw = body.slice(lineStart, lineEnd);
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') {
      if (newline === -1) return body;
      lineStart = newline + 1;
      continue;
    }
    const match = H1_RE.exec(line);
    if (!match || match[1]!.trim() !== title) return body;
    const rest = newline === -1 ? '' : body.slice(newline + 1);
    return lineStart === 0 ? rest : body.slice(0, lineStart) + rest;
  }
}

const EXCERPT_LENGTH = 240;

function makeExcerpt(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length > EXCERPT_LENGTH ? `${collapsed.slice(0, EXCERPT_LENGTH)}…` : collapsed;
}

export interface ParsedWorking {
  id: string;
  slug: string;
  body: string;
  /** Explicit frontmatter `links[]`, RAW (unresolved) — kept alongside the entry because the
   *  entry's own `links` field is the RESOLVED wire shape (`KnowledgeLink[]`), and resolving needs
   *  the whole corpus. A caller that reuses an unchanged file across a reindex (`store.ts`) needs
   *  this raw form back to feed `assembleDocuments` again. */
  links?: string[];
  entry: Omit<CatalogEntry, 'links' | 'backlinkCount'>;
  warnings: string[];
}

/** Read + parse one scanned file into its working shape. `null` on an unreadable file — the
 *  caller counts it as skipped (this function does no accounting itself, so it composes cleanly
 *  into both a fresh scan and `store.ts`'s incremental reindex, which does not have a `ScanAccumulator`
 *  in hand for a single re-parsed file). */
export async function parseScannedFile(file: ScannedFile): Promise<ParsedWorking | null> {
  let raw: string;
  try {
    raw = await readFile(file.absPath, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseDocument(raw, file.absPath, file.format);
  const id = makeId(file.rootId, file.relPath);
  const slug = slugify(parsed.title) || filenameStem(file.absPath);
  const body = stripTitleHeading(parsed.body, parsed.title);
  const headings = extractHeadings(body);
  const updatedAt = parsed.updatedAt ?? new Date(file.mtimeMs).toISOString();
  return {
    id,
    slug,
    body,
    links: parsed.links,
    warnings: parsed.warnings,
    entry: {
      id,
      slug,
      root: file.rootId,
      path: file.absPath,
      title: parsed.title,
      type: parsed.type,
      tags: parsed.tags,
      project: parsed.project,
      domain: parsed.domain,
      changeType: parsed.changeType,
      status: parsed.status,
      statusRaw: parsed.statusRaw,
      supersedes: parsed.supersedes,
      supersededBy: parsed.supersededBy,
      supersededAt: parsed.supersededAt,
      identifiers: parsed.identifiers,
      updatedAt,
      hash: sha256(raw),
      bytes: Buffer.byteLength(raw, 'utf8'),
      headings,
      excerpt: makeExcerpt(body),
      source: parsed.source,
    },
  };
}

interface ResolvedId {
  working: ParsedWorking;
  finalId: string;
}

/**
 * Resolve a 12-hex `id` collision by suffixing the SECOND (and later) document to claim it — both
 * remain addressable (Q7 edge case: "a 12 hex id collision... the second document keeps a suffixed
 * id so both remain addressable"). Astronomically unlikely; still detected, never assumed away.
 *
 * Deliberately NON-mutating: `parsedFiles` may be `knowledge/store.ts`'s long-lived, by-reference
 * `working` cache reused across many reindexes, so writing a suffix back onto `.id`/`.entry.id`
 * would leave a stale suffix baked into an object a LATER reindex reuses unchanged — wrong the
 * moment the collision that produced it no longer exists (its sibling was removed or renamed). The
 * suffix is therefore assembly-time only, recomputed fresh from each working record's stable BASE
 * id every call.
 */
function resolveIds(parsedFiles: readonly ParsedWorking[]): { resolved: ResolvedId[]; idCollisions: number } {
  const seen = new Map<string, number>(); // base id -> occurrences so far, this call only
  let collisions = 0;
  const resolved: ResolvedId[] = [];
  for (const working of parsedFiles) {
    const base = working.id;
    const count = seen.get(base) ?? 0;
    if (count > 0) collisions++;
    seen.set(base, count + 1);
    resolved.push({ working, finalId: count > 0 ? `${base}-${count + 1}` : base });
  }
  return { resolved, idCollisions: collisions };
}

/**
 * The non-I/O half of a build: resolve ids, resolve the link graph over the WHOLE set (link
 * resolution needs every document, not just the changed ones), and merge the resolved
 * `links`/`backlinkCount` into each entry. Exported so `knowledge/store.ts` can call it over a
 * merged (mostly-reused, partly-freshly-parsed) working set for its O(changed) reindex, rather than
 * duplicating this logic.
 */
export function assembleDocuments(parsedFiles: readonly ParsedWorking[]): { documents: ParsedFile[]; idCollisions: number } {
  const { resolved, idCollisions } = resolveIds(parsedFiles);

  const linkable: LinkableDocument[] = resolved.map(({ working, finalId }) => ({
    id: finalId,
    slug: working.slug,
    path: working.entry.path,
    body: working.body,
    links: working.links,
  }));
  const graph = buildLinkGraph(linkable);

  const documents: ParsedFile[] = resolved.map(({ working, finalId }) => {
    const links: ResolvedLink[] = graph.linksByDoc.get(finalId) ?? [];
    const backlinkCount = graph.backlinkCounts.get(finalId) ?? 0;
    return {
      entry: {
        ...working.entry,
        id: finalId,
        links: links.map((l) => ({
          target: l.target,
          resolved: l.resolved,
          id: l.id,
          reason: l.reason,
          candidates: l.candidates,
        })),
        backlinkCount,
      },
      body: working.body,
      warnings: working.warnings,
    };
  });

  return { documents, idCollisions };
}

/** Full scan + parse + link-resolve over every indexed root. Always a complete pass — the O(changed)
 *  incremental path lives in `knowledge/store.ts`, which reuses `scanRoots`/`parseScannedFile`/
 *  `assembleDocuments` directly rather than this convenience wrapper. */
export async function buildCatalog(
  roots: readonly ResolvedKnowledgeRoot[],
  caps: ScanCaps = DEFAULT_SCAN_CAPS,
): Promise<BuildResult> {
  const { files, stats } = await scanRoots(roots, caps);

  const parsedFiles: ParsedWorking[] = [];
  for (const file of files) {
    const parsed = await parseScannedFile(file);
    if (parsed) parsedFiles.push(parsed);
    else stats.skipped++;
  }

  const { documents, idCollisions } = assembleDocuments(parsedFiles);
  return { documents, scan: stats, idCollisions };
}

// ---- manifest + NDJSON persistence -----------------------------------------------------------

/**
 * `formatVersion` mismatch DISCARDS and rebuilds — it never migrates (C11). A corrupt or absent
 * manifest is the same: `null`, which every caller treats as "full rebuild, one warning", never a
 * boot failure.
 */
export async function readManifest(dataDir: string): Promise<KnowledgeManifest | null> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(dataDir), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = knowledgeManifestSchema.safeParse(parsed);
    if (!result.success) return null;
    if (result.data.formatVersion !== CATALOG_FORMAT_VERSION) return null;
    return result.data;
  } catch {
    return null;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(value), 'utf8');
  await rename(tmp, path);
}

export async function writeManifest(dataDir: string, manifest: KnowledgeManifest): Promise<void> {
  await atomicWriteJson(manifestPath(dataDir), manifest);
}

/** One `CatalogEntry` per line — the persisted half of `BuildResult.documents` (no `body`). A line
 *  that fails to parse or validate is dropped with the rest of the file still loaded — the whole
 *  file is a rebuildable cache, so a partial read degrading to "some rows missing until the next
 *  rebuild" is preferable to discarding everything on one bad line. */
export async function readCatalog(dataDir: string): Promise<CatalogEntry[] | null> {
  let raw: string;
  try {
    raw = await readFile(catalogPath(dataDir), 'utf8');
  } catch {
    return null;
  }
  const entries: CatalogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const result = catalogEntrySchema.safeParse(parsed);
      if (result.success) entries.push(result.data);
    } catch {
      // one malformed line — skip it, the rest of the cache is still useful
    }
  }
  return entries;
}

export async function writeCatalog(dataDir: string, entries: readonly CatalogEntry[]): Promise<void> {
  const path = catalogPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
  await writeFile(tmp, body.length > 0 ? `${body}\n` : '', 'utf8');
  await rename(tmp, path);
}

/** Build the manifest row for one root, from the roots it was resolved against. */
export function manifestRootsFrom(roots: readonly ResolvedKnowledgeRoot[]): KnowledgeManifest['roots'] {
  return roots.map((r) => ({ id: r.id, path: r.path, format: r.format, readOnly: !r.writable }));
}
