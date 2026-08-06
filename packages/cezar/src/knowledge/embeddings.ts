import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Knowledge base embeddings (F1, W2.6): the optional upgrade over BM25-plus-identifier-pinning,
 * strictly behind `CEZ_KB_EMBEDDINGS=1`. See
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` (Q5, Q6, "Search and the link graph",
 * the "Embeddings, measured" research note) and `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`
 * D10 for the decisions that outrank the spec on any conflict.
 *
 * A `Float32Array` blob (`embeddings.f32`, chunk-major) plus an NDJSON chunk-metadata sidecar
 * (`embeddings.ndjson`), brute-force cosine at query time. No vector database, no new dependency
 * (D7) - `fetch` and `zod` only, the same pairing `sources/notion/client.ts` already proves from
 * this repo. Measured over the real corpus: ~2,900 chunks x 1536 dims is a 17 MB blob, brute-force
 * cosine under 5 ms, one-off embedding cost ~$0.02 to $0.13.
 *
 * **Every degrade path returns `null` (or `{built:false, reason}`), never throws** (C15): the
 * flag not being the exact string `'1'`, an absent API key, a failed fetch, a dimension mismatch
 * and a corrupt blob all fall back to leaving embeddings unavailable so a caller keeps using BM25.
 * The one directory every derived artifact lives under, `<dataDir>/knowledge-index/`, is already
 * the single entry `ensureDataGitignore` gitignores (`index.ts`'s `wanted` array) - so enabling
 * this file can never commit the 17 MB blob into a user's repo (C16, Q6).
 *
 * **This file owns no shared `knowledge/paths.ts` or `knowledge/search.ts`** - both are owned by
 * other packages (W2.1, W1.3) and, at the time this package was built, `knowledge/paths.ts` had
 * not landed. So the `knowledge-index/` join is computed locally (module-private, matching this
 * codebase's own precedent of `todos.ts`/`handoff.ts` taking a bare `dataDir: string` parameter
 * rather than importing a shared resolver), and reciprocal-rank fusion with a BM25 ranking is
 * exposed here as a pure function (`fuseReciprocalRank`) for whichever package composes the two,
 * rather than reaching into `search.ts` to wire it in directly.
 */

// ---- config --------------------------------------------------------------------------------

export interface EmbeddingsConfig {
  readonly enabled: boolean;
  readonly apiKey?: string;
  readonly url: string;
  readonly model: string;
}

const DEFAULT_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const DEFAULT_EMBEDDINGS_MODEL = 'text-embedding-3-small';

/**
 * `CEZ_KB_EMBEDDINGS` must equal the exact string `'1'` - every other spelling, including
 * `'true'`, `'yes'`, `'0'` and `''`, leaves the feature off (D4, C15, the same exact-string
 * spelling as `CEZ_KB` itself and `handoff.ts`'s `CEZ_FOLLOWUPS`). `CEZ_KB_EMBEDDINGS_URL` and
 * `CEZ_KB_EMBEDDINGS_MODEL` are both defaulted so neither is required to turn embeddings on.
 */
export function resolveEmbeddingsConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingsConfig {
  const enabled = env.CEZ_KB_EMBEDDINGS === '1';
  const apiKey = env.CEZ_KB_EMBEDDINGS_API_KEY?.trim() || undefined;
  const url = env.CEZ_KB_EMBEDDINGS_URL?.trim() || DEFAULT_EMBEDDINGS_URL;
  const model = env.CEZ_KB_EMBEDDINGS_MODEL?.trim() || DEFAULT_EMBEDDINGS_MODEL;
  return { enabled, apiKey, url, model };
}

// ---- paths (Q6, C16: everything derived lives under one directory) -------------------------

/** Module-private: see the file doc-comment above for why this is not imported from
 *  `knowledge/paths.ts`. Computes the identical join the spec's "Catalog cache" tree names. */
function knowledgeIndexDir(dataDir: string): string {
  return join(dataDir, 'knowledge-index');
}

export function embeddingsBlobPath(dataDir: string): string {
  return join(knowledgeIndexDir(dataDir), 'embeddings.f32');
}

export function embeddingsSidecarPath(dataDir: string): string {
  return join(knowledgeIndexDir(dataDir), 'embeddings.ndjson');
}

// ---- chunking (pure) -------------------------------------------------------------------------

export interface EmbeddableDocument {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

interface DocumentChunk {
  readonly docId: string;
  readonly chunkIndex: number;
  readonly text: string;
}

// Both bounds are comfortably under a typical embeddings model's ~8k-token input ceiling. The
// exact figures are not load-bearing - no control in the spec asserts a particular chunk count,
// and the measured "~2,900 chunks over 7.2 MiB / 754 docs" figure is context, not a target.
const CHUNK_TARGET_CHARS = 1800;
const CHUNK_HARD_MAX_CHARS = 3600;

/**
 * Splits one document into embeddable chunks. Paragraph-aware: accumulates blank-line-separated
 * paragraphs up to `CHUNK_TARGET_CHARS`, and hard-splits any single paragraph that alone exceeds
 * `CHUNK_HARD_MAX_CHARS`. Every chunk is prefixed with the document's title, which costs a few
 * tokens per chunk and buys a mid-document chunk enough context to embed sensibly on its own. A
 * document with an empty body still yields one title-only chunk, unless the title is empty too,
 * in which case the document contributes nothing - there is nothing to embed.
 */
function chunkDocument(doc: EmbeddableDocument): DocumentChunk[] {
  const paragraphs = doc.body
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const texts: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current) {
      texts.push(current);
      current = '';
    }
  };
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= CHUNK_TARGET_CHARS) {
      current = candidate;
      continue;
    }
    flush();
    if (paragraph.length <= CHUNK_TARGET_CHARS) {
      current = paragraph;
    } else {
      for (let i = 0; i < paragraph.length; i += CHUNK_HARD_MAX_CHARS) {
        texts.push(paragraph.slice(i, i + CHUNK_HARD_MAX_CHARS));
      }
    }
  }
  flush();

  if (texts.length === 0) {
    const titleOnly = doc.title.trim();
    if (!titleOnly) return [];
    texts.push(titleOnly);
  }

  const title = doc.title.trim();
  return texts.map((text, chunkIndex) => ({
    docId: doc.id,
    chunkIndex,
    text: prefixedChunkText(title, text),
  }));
}

function prefixedChunkText(title: string, text: string): string {
  const combined = title && text !== title ? `${title}\n\n${text}` : text;
  return combined.length > CHUNK_HARD_MAX_CHARS ? combined.slice(0, CHUNK_HARD_MAX_CHARS) : combined;
}

// ---- the embeddings API call (fetch + zod, never throws) -----------------------------------

const embeddingsApiResponseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().int() })),
});

const EMBEDDING_BATCH_SIZE = 96; // comfortably under a typical embeddings-endpoint batch limit
// (OpenAI's is 2048 inputs/call) - keeps one request small and one failure cheap to retry from a
// higher layer. This module reports what happened on one attempt per batch and never retries
// itself, the same "not this module's job" split `sources/notion/client.ts` draws.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type EmbedResult = { ok: true; vectors: number[][]; dims: number } | { ok: false; reason: string };

async function embedBatch(
  texts: readonly string[],
  config: EmbeddingsConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<EmbedResult> {
  if (!config.apiKey) return { ok: false, reason: 'no CEZ_KB_EMBEDDINGS_API_KEY configured' };
  if (texts.length === 0) return { ok: true, vectors: [], dims: 0 };

  let res: Response;
  try {
    res = await fetchImpl(config.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: texts, model: config.model }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: `embeddings request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) return { ok: false, reason: `embeddings API responded ${res.status}` };

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: 'embeddings API returned invalid JSON' };
  }
  const parsed = embeddingsApiResponseSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: `unexpected embeddings API shape: ${parsed.error.message}` };

  const byIndex = new Map(parsed.data.data.map((d) => [d.index, d.embedding]));
  const vectors: number[][] = [];
  let dims = 0;
  for (let i = 0; i < texts.length; i++) {
    const vector = byIndex.get(i);
    if (!vector) return { ok: false, reason: 'embeddings API returned fewer vectors than requested' };
    if (dims === 0) dims = vector.length;
    else if (vector.length !== dims) {
      return { ok: false, reason: 'embeddings API returned inconsistent vector dimensions within one batch' };
    }
    vectors.push(vector);
  }
  return { ok: true, vectors, dims };
}

async function embedAll(
  texts: readonly string[],
  config: EmbeddingsConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<EmbedResult> {
  const vectors: number[][] = [];
  let dims = 0;
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const result = await embedBatch(batch, config, fetchImpl, timeoutMs);
    if (!result.ok) return result;
    if (result.dims > 0) {
      if (dims === 0) dims = result.dims;
      else if (result.dims !== dims) {
        return { ok: false, reason: 'embeddings API returned inconsistent vector dimensions across batches' };
      }
    }
    vectors.push(...result.vectors);
  }
  return { ok: true, vectors, dims };
}

// ---- building and persisting the index --------------------------------------------------------

export interface BuildEmbeddingsIndexOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  now?: () => Date;
}

export interface BuildEmbeddingsIndexResult {
  readonly built: boolean;
  /** Present when `built` is `false` - why nothing was written, never thrown. */
  readonly reason?: string;
  readonly chunkCount?: number;
  readonly dims?: number;
}

/**
 * Chunks every document, embeds every chunk (batched, degrading on the first failure - C15), and
 * writes the blob-plus-sidecar pair atomically under `<dataDir>/knowledge-index/`. Returns
 * `{built:false, reason}` rather than throwing for every degrade path: the flag off, no API key,
 * no documents, or a failed embeddings call.
 */
export async function buildEmbeddingsIndex(
  docs: readonly EmbeddableDocument[],
  dataDir: string,
  options: BuildEmbeddingsIndexOptions = {},
): Promise<BuildEmbeddingsIndexResult> {
  const config = resolveEmbeddingsConfig(options.env ?? process.env);
  if (!config.enabled) return { built: false, reason: 'CEZ_KB_EMBEDDINGS is not the exact string "1"' };
  if (!config.apiKey) return { built: false, reason: 'no CEZ_KB_EMBEDDINGS_API_KEY configured' };

  const chunks = docs.flatMap((doc) => chunkDocument(doc));
  if (chunks.length === 0) return { built: false, reason: 'no documents to embed' };

  const embedded = await embedAll(
    chunks.map((c) => c.text),
    config,
    options.fetchImpl ?? fetch,
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  if (!embedded.ok) return { built: false, reason: embedded.reason };

  await writeEmbeddingsIndex(dataDir, chunks, embedded.vectors, embedded.dims, config.model, options.now ?? (() => new Date()));
  return { built: true, chunkCount: chunks.length, dims: embedded.dims };
}

const embeddingsHeaderSchema = z.object({
  model: z.string(),
  dims: z.number().int().positive(),
  chunkCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});

const embeddingsChunkMetaSchema = z.object({
  docId: z.string(),
  chunkIndex: z.number().int().nonnegative(),
});

async function writeAtomic(path: string, content: string | Uint8Array): Promise<void> {
  // Per-write unique tmp name, the same discipline `sources/sink.ts` uses.
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

async function writeEmbeddingsIndex(
  dataDir: string,
  chunks: readonly DocumentChunk[],
  vectors: readonly number[][],
  dims: number,
  model: string,
  now: () => Date,
): Promise<void> {
  await mkdir(knowledgeIndexDir(dataDir), { recursive: true });

  const blob = new Float32Array(chunks.length * dims);
  for (let i = 0; i < vectors.length; i++) blob.set(vectors[i]!, i * dims);
  await writeAtomic(embeddingsBlobPath(dataDir), new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength));

  const header = { model, dims, chunkCount: chunks.length, createdAt: now().toISOString() };
  const lines = [
    JSON.stringify(header),
    ...chunks.map((c) => JSON.stringify({ docId: c.docId, chunkIndex: c.chunkIndex })),
  ];
  await writeAtomic(embeddingsSidecarPath(dataDir), `${lines.join('\n')}\n`);
}

// ---- loading the index (never throws; any corruption degrades to null, C15) -----------------

export interface LoadedEmbeddingsIndex {
  readonly model: string;
  readonly dims: number;
  readonly chunkCount: number;
  readonly chunks: readonly { readonly docId: string; readonly chunkIndex: number }[];
  /** Chunk-major: chunk `i`'s vector occupies `[i*dims, (i+1)*dims)`. */
  readonly vectors: Float32Array;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Reads the blob-plus-sidecar pair and validates them against each other before trusting either:
 * the sidecar's declared `chunkCount` must match the number of chunk lines actually present, and
 * the blob's byte length must match `chunkCount * dims * 4` exactly. Any mismatch, any missing
 * file, any unparseable line - all degrade to `null` with one warning, never a thrown error and
 * never a silently wrong score (C15's "corrupt blob" case).
 */
export async function loadEmbeddingsIndex(dataDir: string): Promise<LoadedEmbeddingsIndex | null> {
  const sidecarPath = embeddingsSidecarPath(dataDir);
  const blobPath = embeddingsBlobPath(dataDir);

  let sidecarRaw: string;
  let blobRaw: Buffer;
  try {
    [sidecarRaw, blobRaw] = await Promise.all([readFile(sidecarPath, 'utf8'), readFile(blobPath)]);
  } catch {
    return null; // nothing built yet, or one half of the pair is missing - both read as "unavailable"
  }

  const lines = sidecarRaw.split('\n').filter((l) => l.length > 0);
  const headerLine = lines[0];
  if (!headerLine) {
    console.warn(`[cez] embeddings sidecar ${sidecarPath} is empty - ignoring the blob`);
    return null;
  }
  const header = embeddingsHeaderSchema.safeParse(safeJsonParse(headerLine));
  if (!header.success) {
    console.warn(`[cez] embeddings sidecar ${sidecarPath} has an unreadable header - ignoring the blob`);
    return null;
  }

  const chunks: { docId: string; chunkIndex: number }[] = [];
  for (const line of lines.slice(1)) {
    const parsed = embeddingsChunkMetaSchema.safeParse(safeJsonParse(line));
    if (!parsed.success) {
      console.warn(`[cez] embeddings sidecar ${sidecarPath} has a malformed chunk line - ignoring the blob`);
      return null;
    }
    chunks.push(parsed.data);
  }

  const { model, dims, chunkCount } = header.data;
  if (chunks.length !== chunkCount) {
    console.warn(
      `[cez] embeddings sidecar ${sidecarPath} chunk count mismatch (header says ${chunkCount}, found ${chunks.length}) - ignoring the blob`,
    );
    return null;
  }
  const expectedBytes = chunkCount * dims * Float32Array.BYTES_PER_ELEMENT;
  if (blobRaw.byteLength !== expectedBytes) {
    console.warn(
      `[cez] embeddings blob ${blobPath} size mismatch (expected ${expectedBytes} bytes for ${chunkCount} chunks x ${dims} dims, found ${blobRaw.byteLength}) - ignoring the blob`,
    );
    return null;
  }

  // `Buffer`s returned by `fs.readFile` can be a view into Node's shared pool with a byte offset
  // that is NOT a multiple of 4 - `new Float32Array(buf.buffer, buf.byteOffset, ...)` throws in
  // that case. `slice()` copies into a fresh, zero-offset `ArrayBuffer`, so this never throws
  // regardless of how the read buffer happened to be allocated.
  const arrayBuffer = blobRaw.buffer.slice(blobRaw.byteOffset, blobRaw.byteOffset + blobRaw.byteLength);
  const vectors = new Float32Array(arrayBuffer);

  return { model, dims, chunkCount, chunks, vectors };
}

// ---- query-time ranking ------------------------------------------------------------------------

export interface EmbeddingHit {
  readonly docId: string;
  readonly score: number;
}

export interface RankByEmbeddingsOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  limit?: number;
}

const DEFAULT_EMBEDDING_SEARCH_LIMIT = 20;

/**
 * The single orchestrating entry point: resolves config, loads the index, embeds the query, and
 * ranks every document by its best-matching chunk's cosine similarity. Returns `null` - never
 * throws - at every degrade point named by C15: the flag off, no API key, no index built yet (or
 * a corrupt one, caught inside `loadEmbeddingsIndex`), a failed query-embedding fetch, or a
 * dimension mismatch between the query vector just embedded and the vectors stored in the blob
 * (the model changed since the blob was built). Cheap checks run before expensive ones: config,
 * then the on-disk index, then the network call.
 */
export async function rankByEmbeddings(
  query: string,
  dataDir: string,
  options: RankByEmbeddingsOptions = {},
): Promise<readonly EmbeddingHit[] | null> {
  const config = resolveEmbeddingsConfig(options.env ?? process.env);
  if (!config.enabled || !config.apiKey) return null;
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) return null;

  const index = await loadEmbeddingsIndex(dataDir);
  if (!index) return null;

  const embedded = await embedBatch(
    [trimmedQuery],
    config,
    options.fetchImpl ?? fetch,
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  if (!embedded.ok) return null;
  const queryVector = embedded.vectors[0];
  if (!queryVector || embedded.dims !== index.dims) return null; // dimension mismatch - degrade, never a silently wrong score

  const limit = Math.max(1, options.limit ?? DEFAULT_EMBEDDING_SEARCH_LIMIT);
  return bruteForceCosineByDoc(queryVector, index)
    .sort((a, b) => b.score - a.score || (a.docId < b.docId ? -1 : 1))
    .slice(0, limit);
}

function bruteForceCosineByDoc(queryVector: readonly number[], index: LoadedEmbeddingsIndex): EmbeddingHit[] {
  const best = new Map<string, number>();
  for (let i = 0; i < index.chunkCount; i++) {
    const score = cosineSimilarity(queryVector, index.vectors, i * index.dims, index.dims);
    const docId = index.chunks[i]!.docId;
    const current = best.get(docId);
    if (current === undefined || score > current) best.set(docId, score);
  }
  return [...best.entries()].map(([docId, score]) => ({ docId, score }));
}

/** Brute-force cosine between a dense query vector and one chunk-major slice of `blob` starting
 *  at `blobOffset`. Pure, no I/O - the `<5ms over ~2,900 chunks` figure the spec measures. */
export function cosineSimilarity(query: readonly number[], blob: Float32Array, blobOffset: number, dims: number): number {
  let dot = 0;
  let normQuery = 0;
  let normBlob = 0;
  for (let i = 0; i < dims; i++) {
    const q = query[i]!;
    const b = blob[blobOffset + i]!;
    dot += q * b;
    normQuery += q * q;
    normBlob += b * b;
  }
  if (normQuery === 0 || normBlob === 0) return 0;
  return dot / (Math.sqrt(normQuery) * Math.sqrt(normBlob));
}

// ---- reciprocal-rank fusion (pure) -------------------------------------------------------------

const DEFAULT_RRF_K = 60; // the standard reciprocal-rank-fusion constant - dampens how much the
// first couple of ranks dominate, with no per-corpus tuning needed.

/**
 * Reciprocal-rank fusion over already-ranked id lists. Pure and exported so the eventual
 * composition point - whichever package assembles a search response, since this file does not
 * own `knowledge/search.ts` - can fuse an embeddings ranking BELOW a BM25 pin block (spec:
 * "fuses below the pin block, never through it") by passing only the non-pinned tail here, never
 * the pinned prefix. This function has no opinion about pinning; it only fuses the lists it is given.
 */
export function fuseReciprocalRank(rankedIdLists: readonly (readonly string[])[], k: number = DEFAULT_RRF_K): string[] {
  const scores = new Map<string, number>();
  for (const list of rankedIdLists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
}
