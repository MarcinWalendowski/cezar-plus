import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import {
  knowledgeProposalSchema,
  type ApplyKnowledgeProposalsResponse,
  type KnowledgeProposal,
  type KnowledgeSupersedeProposal,
  type KnowledgeUpsertProposal,
} from '@loki-labs/better-cezar-contract';
import { readCatalog } from './catalog.ts';
import { projectKnowledgeRoot, resolveWritablePath, workspaceKnowledgeRoot } from './paths.ts';
import type { CatalogEntry } from './types.ts';

/**
 * Write-back: the agent proposes, cezar applies (W4.2). See
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` ("Agent read path and write back",
 * "Correction in place: the supersede operation") and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` (D1..D25, outranks the spec on conflict).
 *
 * **Alignment note, load-bearing.** The spec's own "Write back proposal" data-model example shows
 * a raw NDJSON line carrying only op-specific fields (no `seq`/`runId`/`createdAt`), implying a
 * server-side enrichment step. The ALREADY-LANDED `server/knowledge-routes.ts` (W4.1, out of this
 * package's scope) reads route 7 (`GET /knowledge/proposals`) by validating each raw line
 * DIRECTLY against the closed wire schema (`knowledgeProposalSchema`, whose `seq`/`runId`/
 * `createdAt` are all required, no defaults) with no enrichment — its own doc comment calls that
 * read path "still real", i.e. the deliberate, permanent shape. `readRunProposals` below matches
 * that behaviour exactly (same file, same schema, same tolerant-line-drop rule) rather than
 * inventing a second, incompatible convention: a proposal line is a complete `KnowledgeProposal`,
 * written by the agent itself (`knowledge/prompt.ts`'s block spells out the exact fields).
 */

export function knowledgeWriteFilePath(dataDir: string, runId: string): string {
  return join(dataDir, 'runs', `${runId}.knowledge.ndjson`);
}

/**
 * Every syntactically-valid, schema-valid line in `<dataDir>/runs/<runId>.knowledge.ndjson`,
 * ordered by `seq`. A missing file is zero proposals (an agent that never wrote one). A line that
 * fails to parse as JSON, or does not match `knowledgeProposalSchema`, is DROPPED — every complete
 * line above and below it still applies (spec edge case: "the proposal file is truncated by a
 * killed agent... a malformed trailing line is dropped... every complete line above it still
 * applies").
 */
export async function readRunProposals(dataDir: string, runId: string): Promise<KnowledgeProposal[]> {
  let raw: string;
  try {
    raw = await readFile(knowledgeWriteFilePath(dataDir, runId), 'utf8');
  } catch {
    return [];
  }
  const proposals: KnowledgeProposal[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = knowledgeProposalSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) proposals.push(parsed.data);
    } catch {
      // malformed line — dropped, the rest of the file is still useful
    }
  }
  return proposals.sort((a, b) => a.seq - b.seq);
}

type ApplyOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Applies the requested `seq` values from one run's proposal file, in the order given. Every
 * outcome is decided independently — one refusal never blocks another proposal in the same
 * batch. Matches `ApplyKnowledgeProposalsResponse` exactly, so a route handler (`server/
 * knowledge-routes.ts`, W4.1) can return this directly.
 */
export async function applyKnowledgeProposals(
  dataDir: string,
  runId: string,
  seqs: readonly number[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApplyKnowledgeProposalsResponse> {
  const proposals = await readRunProposals(dataDir, runId);
  const bySeq = new Map(proposals.map((p) => [p.seq, p] as const));

  const applied: number[] = [];
  const refused: { seq: number; reason: string }[] = [];
  for (const seq of seqs) {
    const proposal = bySeq.get(seq);
    if (!proposal) {
      refused.push({ seq, reason: 'no such proposal' });
      continue;
    }
    const outcome: ApplyOutcome =
      proposal.op === 'upsert' ? await applyUpsert(dataDir, env, proposal) : await applySupersede(dataDir, proposal);
    if (outcome.ok) applied.push(seq);
    else refused.push({ seq, reason: outcome.reason });
  }
  return { applied, refused };
}

// ---- op: upsert -----------------------------------------------------------------------------

async function applyUpsert(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  proposal: KnowledgeUpsertProposal,
): Promise<ApplyOutcome> {
  const rootPath = proposal.scope === 'project' ? projectKnowledgeRoot(dataDir) : workspaceKnowledgeRoot(env);
  const resolved = await resolveWritablePath(rootPath, proposal.path);
  if (!resolved.ok) return { ok: false, reason: resolved.error };

  const frontmatter: Record<string, unknown> = {};
  if (proposal.title) frontmatter.title = proposal.title;
  if (proposal.type) frontmatter.type = proposal.type;
  if (proposal.tags?.length) frontmatter.tags = proposal.tags;
  if (proposal.supersedes?.length) frontmatter.supersedes = proposal.supersedes;

  const content =
    Object.keys(frontmatter).length > 0
      ? `---\n${stringifyYaml(frontmatter)}---\n\n${proposal.body}`
      : proposal.body;

  await writeAtomic(resolved.target, content);
  return { ok: true };
}

// ---- op: supersede — the correction-in-place mechanism ---------------------------------------

const FRONTMATTER_FENCE_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const H1_RE = /^#\s+(.+?)\s*$/;

/** Re-implemented rather than imported from `adapters.ts` (whose fence regex is private, and this
 *  module owns no reach into the read-side adapter internals — the rule is five lines, matching
 *  `paths.ts`'s own precedent for `containsPath`). Tolerant: a fence that fails to parse as a YAML
 *  mapping degrades to `{}`, never throws — "no field is ever fatal" holds on the write side too. */
function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; hadFence: boolean; body: string } {
  const match = FRONTMATTER_FENCE_RE.exec(raw);
  if (!match) return { frontmatter: {}, hadFence: false, body: raw };
  const body = raw.slice(match[0]!.length);
  try {
    const parsed: unknown = parseYaml(match[1] ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Record<string, unknown>, hadFence: true, body };
    }
  } catch {
    // tolerant — fall through to the empty-frontmatter return below
  }
  return { frontmatter: {}, hadFence: true, body };
}

/** `# X` -> `# X (superseded)`, only the FIRST H1 anywhere in the body (matching `parse.ts`'s own
 *  `extractFirstH1`, which scans the whole body rather than only its leading lines). Idempotent: a
 *  heading already carrying the suffix is left alone rather than double-amended — the spec does
 *  not name this sub-case explicitly; this is the documented, defensive reading. */
function amendFirstHeading(body: string): string {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    const match = H1_RE.exec(line);
    if (!match) continue;
    if (line.endsWith('(superseded)')) return body;
    lines[i] = `${line} (superseded)${cr}`;
    return lines.join('\n');
  }
  return body;
}

type DocRef = { ok: true; entry: CatalogEntry } | { ok: false; reason: 'not-found' | 'ambiguous'; candidates?: string[] };

/** "Resolve target by id, then by slug" (spec, apply-algorithm step 1) — exactly two tiers, unlike
 *  wikilink resolution's three (`links.ts` also falls back to the filename stem; proposal target/
 *  `by` resolution deliberately does not, per the spec's literal wording). */
function resolveRef(catalog: readonly CatalogEntry[], ref: string): DocRef {
  const byId = catalog.find((e) => e.id === ref);
  if (byId) return { ok: true, entry: byId };
  const bySlug = catalog.filter((e) => e.slug === ref);
  if (bySlug.length === 1) return { ok: true, entry: bySlug[0]! };
  if (bySlug.length > 1) return { ok: false, reason: 'ambiguous', candidates: bySlug.map((e) => e.id) };
  return { ok: false, reason: 'not-found' };
}

async function applySupersede(dataDir: string, proposal: KnowledgeSupersedeProposal): Promise<ApplyOutcome> {
  const catalog = (await readCatalog(dataDir)) ?? [];

  const targetRef = resolveRef(catalog, proposal.target);
  if (!targetRef.ok) {
    return { ok: false, reason: targetRef.reason === 'ambiguous' ? 'ambiguous target' : 'unknown target document' };
  }
  const entry = targetRef.entry;
  if (entry.root !== 'project' && entry.root !== 'workspace') {
    return { ok: false, reason: 'target is on a read-only mount' };
  }

  let raw: string;
  try {
    raw = await readFile(entry.path, 'utf8');
  } catch {
    return { ok: false, reason: 'target document no longer exists on disk' };
  }
  const version = sha256(raw);

  const { frontmatter, hadFence, body } = splitFrontmatter(raw);

  // Step 3: idempotence. Re-applying the SAME correction is a no-op — byte-identical output (C4).
  if (frontmatter.status === 'superseded' && frontmatter.supersededBy === proposal.by) {
    return { ok: true };
  }

  const byRef = resolveRef(catalog, proposal.by);
  const byTitle = byRef.ok ? byRef.entry.title : proposal.by;
  const byId = byRef.ok ? byRef.entry.id : proposal.by;

  // Step 4: rewrite exactly `status`/`supersededBy`/`supersededAt`, preserving every other
  // existing key untouched. A file with no fence gets a FRESH block containing exactly those
  // three keys plus the derived title (from the catalog entry — already the correct
  // title-fallback resolution, no need to re-derive it here).
  const nextFrontmatter: Record<string, unknown> = {
    ...frontmatter,
    status: 'superseded',
    supersededBy: proposal.by,
    supersededAt: proposal.date,
    ...(hadFence ? {} : { title: entry.title }),
  };

  // Step 7: amend the heading ONLY when asked, and only within the ORIGINAL body — this happens
  // before the lead-in prepend below, so the lead-in text itself is never mistaken for the H1.
  const amendedBody = proposal.amendHeading ? amendFirstHeading(body) : body;

  // Step 5: the lead-in, immediately after frontmatter and before the first byte of the body.
  // Re-applying with a DIFFERENT `by` prepends a SECOND lead-in above whatever is already there
  // (a correction trail) — this falls out naturally: the prepend always happens against whatever
  // the CURRENT body is, prior lead-ins included.
  const note = proposal.note ? ` ${proposal.note}` : '';
  const leadIn = `**Superseded ${proposal.date} by ${byTitle} (${byId}).**${note}\n\n`;

  // Step 6 (the mechanical assertion this whole operation exists to satisfy): with amendHeading
  // false/absent, `result.endsWith(body)` holds by construction — the original body is appended
  // verbatim as the tail, nothing deleted, nothing reflowed, nothing re-serialized.
  const frontmatterBlock = `---\n${stringifyYaml(nextFrontmatter)}---\n`;
  const nextContent = `${frontmatterBlock}${leadIn}${amendedBody}`;

  // Step 2/8: the version guard. Re-read immediately before writing and refuse (writing nothing)
  // if the bytes moved under us since the read above — `agent-config/files.ts`'s exact idiom,
  // applied here as a proposal-apply-time compare-and-swap rather than a client-supplied version.
  let current: string;
  try {
    current = await readFile(entry.path, 'utf8');
  } catch {
    return { ok: false, reason: 'target document no longer exists on disk' };
  }
  if (sha256(current) !== version) {
    return { ok: false, reason: 'target document changed on disk since this proposal was read — retry' };
  }

  await writeAtomic(entry.path, nextContent);
  return { ok: true };
}

// ---- shared write primitive -------------------------------------------------------------------

async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.cez-tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, target);
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
