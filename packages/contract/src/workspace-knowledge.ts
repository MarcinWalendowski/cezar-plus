import { z } from 'zod';
import { knowledgeDocumentSchema } from './knowledge.ts';

/**
 * The WORKSPACE KNOWLEDGE family of `/api/v1/workspace` — a read-only, server-side aggregate over
 * every registered project's knowledge base (D3/D5/D6, `.ai/specs/2026-08-14-knowledge-domains-
 * and-changelog.md`). Three routes: `search`, `domains`, and `changelog` (D3) — the changelog is a
 * PROJECTION over the same indexed documents (those carrying `changeType`), not a second store.
 * See `./knowledge.ts` for the per-project family this extends across projects; nothing here is a
 * second knowledge system, only a cross-project read over the same documents.
 *
 * The read path (`workspace/knowledge-index.ts`) peeks an already-built project context's
 * `knowledgeStore` where one is live, and otherwise opens a standalone `KnowledgeStore` — it never
 * builds a context (D5). Nothing in this contract file changes that; it only describes the shape
 * the index hands back.
 *
 * **Flag-off shape (D6, D19).** `GET /workspace/knowledge/*` gates on BOTH
 * `capabilities.knowledge` (`CEZ_KB=1`) and `capabilities.workspaceViews` (`CEZ_WORKSPACE_VIEWS=1`)
 * — it is a knowledge feature AND a cross-project aggregate, and either being off is a real reason
 * not to serve it. Off answers 200 with a schema-valid empty payload, never 404. Because an ANDed
 * flag cannot say which conjunct is false, `disabledReason` names the ONE capability that was off
 * (checked `knowledge` first, then `workspaceViews`) — absent only when both are on.
 */

/**
 * One document in a cross-project result, stamped with the REGISTERED project (repo) it was found
 * in. Deliberately wrapped rather than flattened like `WorkspaceRunSummary` (`./workspace-runs.ts`)
 * flattens its own `project` stamp onto `RunRecord`: `KnowledgeDocument` already has an OPTIONAL
 * `project` field of its own (the document's declared axis within ITS repo's knowledge base, e.g.
 * "beside" vs "chat" inside one monorepo) — flattening a second, differently-scoped `project` onto
 * the same key would silently shadow one or the other. `project` here is unambiguously "which
 * registered repo", matching `WorkspaceGitProject`/`WorkspaceProjectHealth`'s own `id` field for
 * the same concept, just named for what it is at the call site.
 */
export const workspaceKnowledgeResultSchema = z.object({
  /** Registry project id — never the document's own (optional) `document.project` field. */
  project: z.string(),
  /** No `body` — this is a search-result row, matching the per-project `GET /knowledge/search`. */
  document: knowledgeDocumentSchema.omit({ body: true }),
});
export type WorkspaceKnowledgeResult = z.infer<typeof workspaceKnowledgeResultSchema>;

/** Per-project health, so a dead or disabled project is RENDERED, never silently absent — matching
 *  `WorkspaceProjectHealth`/`WorkspaceGitProject`'s degradation contract (a missing root, a store
 *  that failed to build, or one that tripped its per-project deadline is a ROW, never a gap). */
export const workspaceKnowledgeProjectHealthSchema = z.object({
  id: z.string(),
  name: z.string(),
  ok: z.boolean(),
  reason: z.string().optional(),
});
export type WorkspaceKnowledgeProjectHealth = z.infer<typeof workspaceKnowledgeProjectHealthSchema>;

/** Names which of the two ANDed capabilities was off (D6) — absent when both are on. */
export const workspaceKnowledgeDisabledReasonSchema = z.enum(['knowledge', 'workspaceViews']);
export type WorkspaceKnowledgeDisabledReason = z.infer<typeof workspaceKnowledgeDisabledReasonSchema>;

/** `GET /workspace/knowledge/search`. Every field is a stored value — no clock-derived field rides
 *  this body, matching `workspaceRunsResponseSchema`'s own D8 note. */
export const workspaceKnowledgeSearchResponseSchema = z.object({
  query: z.string(),
  total: z.number().int(),
  truncated: z.boolean(),
  results: z.array(workspaceKnowledgeResultSchema),
  projects: z.array(workspaceKnowledgeProjectHealthSchema),
  disabledReason: workspaceKnowledgeDisabledReasonSchema.optional(),
});
export type WorkspaceKnowledgeSearchResponse = z.infer<typeof workspaceKnowledgeSearchResponseSchema>;

/**
 * One domain row (D1): `distinct(domain)` over every considered project's index, unioned.
 * `indexDocId` is the id of the document whose `slug` equals `domain` (D1's convention,
 * `<knowledge-root>/domains/<id>.md`), when the corpus has one — a domain with documents but NO
 * index document is still a row here, with `indexDocId` absent. That absence is a real state the
 * page must show honestly, never a reason to drop the row (spec Verification table).
 */
export const workspaceKnowledgeDomainSchema = z.object({
  domain: z.string(),
  docCount: z.number().int(),
  /** Registry project ids that contributed at least one document to this domain, sorted. */
  projects: z.array(z.string()),
  indexDocId: z.string().optional(),
});
export type WorkspaceKnowledgeDomain = z.infer<typeof workspaceKnowledgeDomainSchema>;

/** `GET /workspace/knowledge/domains`. */
export const workspaceKnowledgeDomainsResponseSchema = z.object({
  domains: z.array(workspaceKnowledgeDomainSchema),
  projects: z.array(workspaceKnowledgeProjectHealthSchema),
  disabledReason: workspaceKnowledgeDisabledReasonSchema.optional(),
});
export type WorkspaceKnowledgeDomainsResponse = z.infer<typeof workspaceKnowledgeDomainsResponseSchema>;

/**
 * `GET /workspace/knowledge/changelog` (D3). A changelog entry IS a knowledge document carrying
 * `changeType` — this reuses `workspaceKnowledgeResultSchema`'s `{project, document}` row rather
 * than inventing a second wire shape for the same underlying object; `document.changeType` is
 * always present on an entry here (the projection filters on it), `document.domain` is not
 * (filing under a domain is independent of being a changelog entry).
 *
 * `entries` is sorted by the entry's own `document.updatedAt` descending, id ascending on a tie —
 * never scan/registry order, so the list does not reshuffle between reloads when nothing changed.
 *
 * `sinceExcludedAll` distinguishes "the `since` filter excluded every entry" from "there are no
 * entries at all" — the same ambiguity `disabledReason` exists to remove for the two-flag gate,
 * applied to `since` instead. `true` only when `since` was supplied AND at least one entry existed
 * before `since` was applied AND none survive it. Absent in every other case, including "no
 * entries exist at all" (with or without `since`) and "`since` was not supplied" — it is not a
 * generic "empty" flag, only a "your filter did this" flag.
 */
export const workspaceKnowledgeChangelogResponseSchema = z.object({
  entries: z.array(workspaceKnowledgeResultSchema),
  projects: z.array(workspaceKnowledgeProjectHealthSchema),
  sinceExcludedAll: z.boolean().optional(),
  disabledReason: workspaceKnowledgeDisabledReasonSchema.optional(),
});
export type WorkspaceKnowledgeChangelogResponse = z.infer<typeof workspaceKnowledgeChangelogResponseSchema>;
