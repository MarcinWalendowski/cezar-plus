import { Hono } from 'hono';
import { z } from 'zod';
import {
  type WorkspaceKnowledgeChangelogResponse,
  type WorkspaceKnowledgeDocumentResponse,
  type WorkspaceKnowledgeDomainsResponse,
  type WorkspaceKnowledgeSearchResponse,
} from '@loki-labs/better-cezar-contract';
import { resolveCapabilities } from './capabilities.ts';
import type { ProjectApiEnv } from './server.ts';
import {
  WorkspaceKnowledgeIndex,
  type WorkspaceKnowledgeContexts,
  type WorkspaceKnowledgeProjectSource,
  type WorkspaceKnowledgeSearchOptions,
} from '../workspace/knowledge-index.ts';
import { listProjects } from '../workspace/projects.ts';
import { queryZodValidator } from './validators.ts';

/**
 * `GET /api/v1/workspace/knowledge/search`, `GET /api/v1/workspace/knowledge/domains`,
 * `GET /api/v1/workspace/knowledge/document`, and `GET /api/v1/workspace/knowledge/changelog` —
 * the cross-project knowledge read (D3/D5/D6, `.ai/specs/2026-08-14-knowledge-domains-and-
 * changelog.md`; `document` added by `.ai/specs/2026-08-17-workspace-knowledge-speed-preview.md`
 * for the right-pane preview). `changelog` and `document` are both projections over the same read
 * path (`WorkspaceKnowledgeIndex`), not separate mechanisms.
 *
 * **READ never instantiates.** `deps.contexts` is injected, narrowed to `peek` only (the
 * `workspace-run-mutations-routes.ts` precedent) — this file never imports `./project-context.ts`
 * or `../workflows/run.ts`. `deps.knowledgeIndex` defaults to a fresh `WorkspaceKnowledgeIndex`
 * built from the plain, already-exported `listProjects()` registry lookup, matching
 * `./workspace-git-routes.ts`'s own default-index pattern.
 *
 * **Gated on BOTH `capabilities.knowledge` and `capabilities.workspaceViews` (D6) — the AND-gate
 * that must name which conjunct is off.** A single generic "disabled" message cannot say which of
 * two flags is the one to flip, so the empty payload's `disabledReason` names the ONE that is off:
 * `knowledge` is checked first (an off knowledge base is off regardless of the cross-project flag),
 * then `workspaceViews`. Both on is the only way to get a real answer. Off is 200 with a
 * schema-valid empty payload, never 404 (D19) — this is our own opt-in aggregate, not an always-on
 * upstream board.
 *
 * Workspace-level and single-mount — never mirrored under `/api/v1/p/:projectId`
 * (`BACKWARD_COMPATIBILITY.md` §2). Read-only, so there is no mutator to 409.
 */

export interface WorkspaceKnowledgeRouteDeps {
  /** Injected rather than imported — importing `./project-context.ts` is exactly what the
   *  structural guard (`../workspace/knowledge-index.ts`'s own doc comment) forbids. */
  contexts: WorkspaceKnowledgeContexts;
  /** Defaults to a fresh `WorkspaceKnowledgeIndex` reading the real registry. Injected so tests
   *  hand it a hermetic fixture instead of `~/.cezar`. */
  knowledgeIndex?: WorkspaceKnowledgeIndex;
}

function toKnowledgeIndexSource(project: {
  id: string;
  root: string;
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
  name: string;
}): WorkspaceKnowledgeProjectSource {
  return { id: project.id, root: project.root, status: project.status, name: project.name || '' };
}

function defaultKnowledgeIndex(contexts: WorkspaceKnowledgeContexts): WorkspaceKnowledgeIndex {
  return new WorkspaceKnowledgeIndex({
    contexts,
    listProjects: async () => (await listProjects()).map(toKnowledgeIndexSource),
  });
}

const searchQuerySchema = z.object({
  q: z.string().max(500).optional(),
  domain: z.string().max(200).optional(),
  project: z.string().max(200).optional(),
  type: z.string().max(64).optional(),
  status: z.string().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const EMPTY_SEARCH: Omit<WorkspaceKnowledgeSearchResponse, 'query' | 'disabledReason'> = {
  total: 0,
  truncated: false,
  results: [],
  projects: [],
};

const EMPTY_DOMAINS: Omit<WorkspaceKnowledgeDomainsResponse, 'disabledReason'> = {
  domains: [],
  projects: [],
};

const documentQuerySchema = z.object({
  project: z.string().min(1).max(200),
  doc: z.string().min(1).max(200),
});

const changelogQuerySchema = z.object({
  domain: z.string().max(200).optional(),
  project: z.string().max(200).optional(),
  since: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// No `sinceExcludedAll` here (unlike EMPTY_SEARCH/EMPTY_DOMAINS' pattern) — it is a computed fact
// about a `since` filter that never ran when the gate is off, not a stored default.
const EMPTY_CHANGELOG: Omit<WorkspaceKnowledgeChangelogResponse, 'disabledReason'> = {
  entries: [],
  projects: [],
};

/** The one capability that is off, checked in this fixed order — `undefined` when both are on.
 *  D6: a single message cannot say which of two ANDed flags is false, so this is the ONE thing
 *  that must return the right conjunct, not just "disabled". */
function disabledReason(): 'knowledge' | 'workspaceViews' | undefined {
  const caps = resolveCapabilities(process.env);
  if (!caps.knowledge) return 'knowledge';
  if (!caps.workspaceViews) return 'workspaceViews';
  return undefined;
}

export function createWorkspaceKnowledgeRoutes(deps: WorkspaceKnowledgeRouteDeps) {
  const index = deps.knowledgeIndex ?? defaultKnowledgeIndex(deps.contexts);

  return new Hono<ProjectApiEnv>()
    .get('/workspace/knowledge/search', queryZodValidator(searchQuerySchema), async (c) => {
      const { q, domain, project, type, status, limit, offset } = c.req.valid('query');
      const query = q ?? '';
      const reason = disabledReason();
      if (reason) {
        const body: WorkspaceKnowledgeSearchResponse = { query, ...EMPTY_SEARCH, disabledReason: reason };
        return c.json(body);
      }
      const result = await index.search(query, {
        projects: project ? [project] : undefined,
        domain,
        type,
        // `status` is validated as a bounded string above, not the narrower search-side enum —
        // matching `./knowledge-routes.ts`'s own precedent: an out-of-vocabulary value simply
        // matches nothing, never a 400 for a shape that IS a valid query string.
        status: status as WorkspaceKnowledgeSearchOptions['status'],
        limit,
        offset,
      });
      const body: WorkspaceKnowledgeSearchResponse = { ...result };
      return c.json(body);
    })

    .get('/workspace/knowledge/domains', async (c) => {
      const reason = disabledReason();
      if (reason) {
        const body: WorkspaceKnowledgeDomainsResponse = { ...EMPTY_DOMAINS, disabledReason: reason };
        return c.json(body);
      }
      const result = await index.domains();
      const body: WorkspaceKnowledgeDomainsResponse = { ...result };
      return c.json(body);
    })

    // `GET /workspace/knowledge/document` (`.ai/specs/2026-08-17-workspace-knowledge-speed-
    // preview.md`) — the right-pane preview read: 200 `{document: null}` when a capability is
    // off (D19, same as every other read here), 404 for an unregistered project or an unknown
    // doc id once both are on — that null is reserved for "the feature is off", never "not
    // found" (the same split `./knowledge-routes.ts`'s `GET /knowledge/:id` already makes).
    .get('/workspace/knowledge/document', queryZodValidator(documentQuerySchema), async (c) => {
      const { project, doc } = c.req.valid('query');
      const reason = disabledReason();
      if (reason) {
        const body: WorkspaceKnowledgeDocumentResponse = { project, document: null, disabledReason: reason };
        return c.json(body);
      }
      const result = await index.getDocument(project, doc);
      if (!result.ok) return c.json({ error: 'no such document' }, 404);
      const body: WorkspaceKnowledgeDocumentResponse = { project, document: result.document };
      return c.json(body);
    })

    .get('/workspace/knowledge/changelog', queryZodValidator(changelogQuerySchema), async (c) => {
      const { domain, project, since, limit } = c.req.valid('query');
      const reason = disabledReason();
      if (reason) {
        const body: WorkspaceKnowledgeChangelogResponse = { ...EMPTY_CHANGELOG, disabledReason: reason };
        return c.json(body);
      }
      const result = await index.changelog({
        projects: project ? [project] : undefined,
        domain,
        since,
        limit,
      });
      const body: WorkspaceKnowledgeChangelogResponse = { ...result };
      return c.json(body);
    });
}
