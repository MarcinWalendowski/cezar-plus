import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  applyKnowledgeProposalsInputSchema,
  createKnowledgeDocumentInputSchema,
  knowledgeProposalSchema,
  updateKnowledgeDocumentInputSchema,
  type ApplyKnowledgeProposalsResponse,
  type KnowledgeDocumentResponse,
  type KnowledgeProposal,
  type KnowledgeProposalsResponse,
  type KnowledgeReindexResponse,
  type KnowledgeRemovedResponse,
  type KnowledgeResponse,
  type KnowledgeSearchResponse,
} from '@loki-labs/better-cezar-contract';
import type { SearchFilters } from '../knowledge/search.ts';
import { jsonZodValidator, queryZodValidator } from './validators.ts';
import type { ProjectApiEnv } from './server.ts';

/**
 * The KNOWLEDGE family of `/api/v1` (F1, `CEZ_KB=1`). See
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` ("API Contracts", nine routes) and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D19.
 *
 * **W4.1 fill-in.** Every handler reads `c.get('project').knowledgeStore` — never a boot-level
 * store — and gates on ITS presence, which is exactly `CEZ_KB === '1'` for that project
 * (`activateOptionalStores` in `project-context.ts`, W3.1 — called by BOTH the lazy build path and
 * `createApp`'s boot context; until 2026-08-06 only the former called it, so this sentence was
 * false for the boot project and its knowledge base was permanently 409/empty). `undefined`
 * reproduces the scaffold's D19 flag-off shape (every
 * GET a schema-valid empty payload, every mutator a fixed 409); a present store answers for real
 * off `KnowledgeStore`'s (W2.1) own CRUD/search/reindex methods.
 *
 * **Routes 7/8 (proposals) are a deliberate partial fill-in, not an oversight.** The apply
 * mechanism — reading a run's proposal NDJSON, running the `upsert`/`supersede` algorithms — is
 * spec'd under `knowledge/{prompt,proposals}.ts` (W4.2), which this package does not own and which
 * does not exist in this checkout (the PLAN's W4.1 deps list is W3.1/W2.1/W1.3, not W4.2 — a gap
 * worth the orchestrator's attention). `GET /knowledge/proposals` is still real: it reads and
 * validates every `<dataDir>/runs/*.knowledge.ndjson` line directly, which is a pure read and
 * squarely an HTTP-handler concern. `POST /knowledge/proposals/apply` validates the run exists
 * (404 unknown run) and the requested `seq` values resolve to real proposal lines, but never
 * pretends to apply one: `applied` stays empty and every requested `seq` comes back in `refused`
 * with an honest reason. Once `knowledge/proposals.ts` lands, this handler should call into it
 * instead of answering `PROPOSAL_APPLY_NOT_AVAILABLE`.
 *
 * Chained into ONE family with an INFERRED return type (never annotated, never a loose
 * `app.get(...)`): both drop a route from `AppType` silently while the server keeps serving it
 * (`typed-bodies.test.ts`). Mounted into `v1` in `server.ts`, so it answers at the unscoped
 * `/api/v1/*`, the scoped `/api/v1/p/:projectId/*`, and the `/api/v1/p/default/*` alias — all three
 * byte-identically, verified generically by `route-parity.test.ts`.
 */

export interface KnowledgeRouteDeps {}

/** Fixed message naming the flag, matching the `FOLLOWUPS_OFF` precedent (`server.ts:393`). Every
 *  mutator in this family answers it with a 409 when `knowledgeStore` is absent — never a 404,
 *  because the feature is switched off, not missing (D19). */
const KNOWLEDGE_OFF = 'the knowledge base is disabled — set CEZ_KB=1 to enable it';

/** The route-8 refusal reason for a proposal that resolves but has no applier yet — see the
 *  module doc comment. Distinct from `KNOWLEDGE_OFF`: the flag really is on here, so a caller
 *  must never be told otherwise. */
const PROPOSAL_APPLY_NOT_AVAILABLE = 'applying knowledge proposals is not implemented yet';

/** Schema-valid empty payload for `GET /knowledge` (route 1). Every field is the same type as the
 *  "on" answer, never a second shape a client would have to branch on. */
const EMPTY_KNOWLEDGE_RESPONSE: KnowledgeResponse = {
  enabled: false,
  roots: [],
  counts: { documents: 0, idCollisions: 0 },
  facets: { types: [], tags: [], statuses: [], roots: [], domains: [] },
  scan: { truncated: false, filesScanned: 0, bytesScanned: 0, skipped: 0 },
  formatVersion: 0,
};

const knowledgeSearchQuerySchema = z.object({
  q: z.string().max(500).optional(),
  type: z.string().max(64).optional(),
  tag: z.string().max(64).optional(),
  status: z.string().max(32).optional(),
  root: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ---- proposal NDJSON reads (routes 7/8) --------------------------------------------------------
//
// `<dataDir>/runs/<runId>.knowledge.ndjson` (spec "Catalog cache"; `runs/` is already gitignored,
// matching `RunStore`'s own `runs/<id>.ndjson` transcript convention, `runs/store.ts:958`). Reading
// is pure: one file read, one line-by-line zod parse. A line that fails to parse as JSON or as
// `knowledgeProposalSchema` is dropped rather than failing the whole read — the spec's own edge
// case ("the proposal file is truncated by a killed agent... a malformed trailing line is dropped
// with a warning and every complete line above it still applies").

const PROPOSAL_FILE_SUFFIX = '.knowledge.ndjson';

function parseProposalLine(line: string): KnowledgeProposal | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = knowledgeProposalSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readProposalFile(path: string): Promise<KnowledgeProposal[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const proposals: KnowledgeProposal[] = [];
  for (const line of raw.split('\n')) {
    const proposal = parseProposalLine(line);
    if (proposal) proposals.push(proposal);
  }
  return proposals;
}

/** Every run's proposals, deterministically ordered `(runId, seq)` (D8: two consecutive GETs must
 *  be byte identical). A missing `runs/` directory is zero proposals, never a throw. */
async function readAllProposals(dataDir: string): Promise<KnowledgeProposal[]> {
  const runsDir = join(dataDir, 'runs');
  let names: string[];
  try {
    names = await readdir(runsDir);
  } catch {
    return [];
  }
  const proposals: KnowledgeProposal[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(PROPOSAL_FILE_SUFFIX)) continue;
    proposals.push(...(await readProposalFile(join(runsDir, name))));
  }
  proposals.sort((a, b) => (a.runId === b.runId ? a.seq - b.seq : a.runId.localeCompare(b.runId)));
  return proposals;
}

async function readRunProposals(dataDir: string, runId: string): Promise<KnowledgeProposal[]> {
  const proposals = await readProposalFile(join(dataDir, 'runs', `${runId}${PROPOSAL_FILE_SUFFIX}`));
  return proposals.sort((a, b) => a.seq - b.seq);
}

export function createKnowledgeRoutes(_deps: KnowledgeRouteDeps = {}) {
  return new Hono<ProjectApiEnv>()
    // ---- reads (route 1, 2, 7): 200, schema-valid empty when off, never 404 ------------------
    .get('/knowledge', (c) => {
      const store = c.get('project').knowledgeStore;
      if (!store) return c.json(EMPTY_KNOWLEDGE_RESPONSE);
      const body: KnowledgeResponse = {
        enabled: true,
        roots: store.getRoots(),
        counts: store.getCounts(),
        facets: store.getFacets(),
        scan: store.getScan(),
        formatVersion: store.getFormatVersion(),
      };
      return c.json(body);
    })

    .get('/knowledge/search', queryZodValidator(knowledgeSearchQuerySchema), (c) => {
      const { q, type, tag, status, root, limit, offset } = c.req.valid('query');
      const store = c.get('project').knowledgeStore;
      if (!store) {
        const body: KnowledgeSearchResponse = { query: q ?? '', total: 0, truncated: false, results: [] };
        return c.json(body);
      }
      // `status` is validated as a bounded string above, not the narrower search-side enum: the
      // enum lives in `knowledge/search.ts` (W1.3), a pure module this route only consumes. An
      // out-of-vocabulary value simply matches nothing, which is the correct behaviour for a
      // facet filter — never a 400 for a shape that IS a valid query string.
      const result = store.search(q ?? '', {
        type,
        tag,
        status: status as SearchFilters['status'],
        root,
        limit,
        offset,
      });
      return c.json(result satisfies KnowledgeSearchResponse);
    })

    .get('/knowledge/proposals', async (c) => {
      const { dataDir, knowledgeStore } = c.get('project');
      if (!knowledgeStore) {
        const body: KnowledgeProposalsResponse = { proposals: [] };
        return c.json(body);
      }
      const proposals = await readAllProposals(dataDir);
      const body: KnowledgeProposalsResponse = { proposals };
      return c.json(body);
    })

    // ---- mutators (routes 4, 5, 6, 8, 9): real success branch when on, 409 when off -----------
    .post('/knowledge', jsonZodValidator(createKnowledgeDocumentInputSchema), async (c) => {
      const store = c.get('project').knowledgeStore;
      if (!store) return c.json({ error: KNOWLEDGE_OFF }, 409);
      const result = await store.createDocument(c.req.valid('json'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      const body: KnowledgeDocumentResponse = { document: result.document };
      return c.json(body, 201);
    })

    .post('/knowledge/proposals/apply', jsonZodValidator(applyKnowledgeProposalsInputSchema), async (c) => {
      const project = c.get('project');
      if (!project.knowledgeStore) return c.json({ error: KNOWLEDGE_OFF }, 409);
      const { runId, seq } = c.req.valid('json');
      if (!project.store.getRun(runId)) return c.json({ error: `unknown run: ${runId}` }, 404);

      // No applier exists yet (see module doc comment) — every requested seq is refused with an
      // HONEST reason (never silently dropped, never faked as applied). `applied` stays empty
      // until `knowledge/proposals.ts` (W4.2) lands and this handler is wired to it.
      const proposals = await readRunProposals(project.dataDir, runId);
      const bySeq = new Map(proposals.map((p) => [p.seq, p] as const));
      const body: ApplyKnowledgeProposalsResponse = {
        applied: [],
        refused: seq.map((s) => ({
          seq: s,
          reason: bySeq.has(s) ? PROPOSAL_APPLY_NOT_AVAILABLE : 'no such proposal',
        })),
      };
      return c.json(body);
    })

    .post('/knowledge/reindex', async (c) => {
      const store = c.get('project').knowledgeStore;
      if (!store) return c.json({ error: KNOWLEDGE_OFF }, 409);
      const body: KnowledgeReindexResponse = await store.reindexNow();
      return c.json(body);
    })

    // ---- single document (route 3): 200 `{document: null}` when off, 404 unknown id when on --
    // Registered after the static routes above (`search`, `proposals`, `reindex`) so a reader
    // sees the fixed segments before the catch-all `:id` — Hono itself resolves a static path
    // ahead of a param one regardless of registration order (`/runs/archive-finished` vs
    // `/runs/:id`, `server.ts:3453,3568`), so this is for readability, not correctness.
    .get('/knowledge/:id', (c) => {
      const store = c.get('project').knowledgeStore;
      if (!store) {
        const body: KnowledgeDocumentResponse = { document: null };
        return c.json(body);
      }
      const document = store.getDocument(c.req.param('id'));
      if (!document) return c.json({ error: 'no such document' }, 404);
      const body: KnowledgeDocumentResponse = { document };
      return c.json(body);
    })

    .put('/knowledge/:id', jsonZodValidator(updateKnowledgeDocumentInputSchema), async (c) => {
      const store = c.get('project').knowledgeStore;
      if (!store) return c.json({ error: KNOWLEDGE_OFF }, 409);
      const result = await store.updateDocument(c.req.param('id'), c.req.valid('json'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      const body: KnowledgeDocumentResponse = { document: result.document };
      return c.json(body);
    })

    .delete('/knowledge/:id', async (c) => {
      const store = c.get('project').knowledgeStore;
      if (!store) return c.json({ error: KNOWLEDGE_OFF }, 409);
      const result = await store.deleteDocument(c.req.param('id'));
      if (!result.ok) return c.json({ error: result.error }, result.status);
      const body: KnowledgeRemovedResponse = { removed: true };
      return c.json(body);
    });
}
