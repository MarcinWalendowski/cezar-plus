import { join } from 'node:path';
import { Hono } from 'hono';
import {
  approveReportInputSchema,
  dismissReportInputSchema,
  reportsQuerySchema,
  type ReportApproveResponse,
  type ReportCounts,
  type ReportDetailResponse,
  type ReportDismissResponse,
  type ReportListItem,
  type ReportProcessOutcome,
  type ReportProcessPendingResponse,
  type ReportReopenResponse,
  type ReportsResponse,
  type ReportStatus,
  type ReportStatusSource,
  type ReportTriageRow,
} from '@loki-labs/better-cezar-contract';
import type { CatalogEntry } from '../knowledge/types.ts';
import { createTodo, readTodos } from '../todos.ts';
import { readReportTriage, updateReportTriage } from '../reports-triage.ts';
import { jsonZodValidator, queryZodValidator } from './validators.ts';
import type { ProjectApiEnv } from './server.ts';

/**
 * The REPORTS family of `/api/v1` — triage over the report documents already in a project's
 * knowledge base. See `.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`.
 *
 * **The list is a join, not a store.** Reports are knowledge documents carrying the reports tag;
 * this family adds no document type, no second index, and writes nothing on a read. A report with
 * no triage row and no handled tag of its own reads as `pending`, which is what lets a freshly
 * arrived report appear in the inbox the moment `fs.watch` indexes the file — no write anywhere.
 * See {@link derivedStatus} for why the document's own status tag is part of that derivation.
 *
 * **Why this family exists at all.** A report reaching the knowledge base is invisible on the
 * Tasks board, which renders `todos.json` and never reads the KB. That is not a bug to fix by
 * teaching the board about documents — the two stores have different jobs (the inbox is
 * actionable, the corpus is the archive). So triage is an explicit act that mints a todo, and
 * this is where it lives.
 *
 * **Every handler gates on `knowledgeStore`,** exactly as the KNOWLEDGE family does: reads answer
 * 200 with a schema-valid empty payload when the store is absent, mutators answer 409 naming the
 * flag. Never 404 — the feature is switched off, not missing.
 *
 * Chained into ONE family with an INFERRED return type (never annotated, never a loose
 * `app.get(...)`): both drop a route from `AppType` silently while the server keeps serving it.
 */

/** Fixed message naming the flag, matching `knowledge-routes.ts`'s `KNOWLEDGE_OFF` precedent. */
const REPORTS_OFF = 'reports ride on the knowledge base — set CEZ_KB=1 to enable them';

/** `process-pending` is refused unless auto mode is explicitly on, so a stray call can never
 *  mass-convert an inbox someone intended to triage by hand. */
const AUTO_OFF = 'automatic report processing is off — set CEZ_REPORTS_AUTO=1 to enable it';

/** The default tags that mark a knowledge document as a report. Configurable because the tag is
 *  deployment vocabulary, not something this package gets to decide. `notion-report` is included
 *  by default because corpora migrated from an earlier tracker carry it on historical rows. */
export const DEFAULT_REPORT_TAGS = ['user-report', 'notion-report'] as const;

/**
 * Tags that mean "this report was already handled, before this feature existed".
 *
 * `status/processed` is the vocabulary a tracker migration writes: a corpus imported from an earlier
 * issue tracker typically carries it on nearly every historical row (measured on one such corpus:
 * 191 of 193 reports processed, 2 new). Without this, the queue would open on all of them and
 * re-ask questions someone already answered — and an automatic pass would mint a task for each. So
 * the document's own statement about itself is honoured as the INITIAL state, and the triage store
 * overrides it; `statusSource` on the wire keeps the two distinguishable rather than pretending a
 * migrated tag is somebody's decision.
 */
export const DEFAULT_HANDLED_TAGS = ['status/processed'] as const;

/** Every knob this family reads, resolved per request for the project being addressed. */
export interface ReportsConfig {
  /** Which tags mark a document as a report. */
  tags: readonly string[];
  /** Which tags mean the report was already handled elsewhere — see {@link DEFAULT_HANDLED_TAGS}. */
  handledTags: readonly string[];
  /** Whether `process-pending` is permitted. */
  auto: boolean;
  /** `domain` on the report document → the project id whose inbox its work belongs in. A report's
   *  `domain` is a PRODUCT axis while a todo inbox is a REPO, and the map between them is
   *  deployment-specific — so it is configuration, never a table in this source. */
  routeByDomain: Readonly<Record<string, string>>;
}

const DEFAULT_REPORTS_CONFIG: ReportsConfig = {
  tags: DEFAULT_REPORT_TAGS,
  handledTags: DEFAULT_HANDLED_TAGS,
  auto: false,
  routeByDomain: {},
};

const EMPTY_COUNTS: ReportCounts = { pending: 0, approved: 0, dismissed: 0, total: 0 };

const EMPTY_REPORTS_RESPONSE: ReportsResponse = {
  enabled: false,
  items: [],
  counts: EMPTY_COUNTS,
  truncated: false,
};

const EMPTY_DETAIL_RESPONSE: ReportDetailResponse = { enabled: false, item: null, body: '' };

export interface ReportsRouteProjectSource {
  id: string;
  root: string;
}

export interface ReportsRouteDeps {
  /** Registry lookup, injected (the `WorkspaceTodoIndex` precedent) so a unit test never reads the
   *  real `~/.cezar`. Absent = approvals may only mint into the report's own project. */
  listProjects?: () => Promise<readonly ReportsRouteProjectSource[]>;
  /**
   * Resolve this family's config for the project being addressed. Called PER REQUEST and never
   * cached, for `loadConfig`'s own stated reason: a snapshot of a file two processes share is a
   * staleness bug. Reading it per project rather than once at boot matters here — the routing map
   * says where a report's work belongs, and that is a property of the corpus being triaged.
   */
  reportsConfig?: (projectRoot: string) => Promise<ReportsConfig>;
}

/** The triage key for a document: its provenance identifier when it has one, else the catalog id.
 *  The identifier is minted once by whatever wrote the document and survives a reindex; the
 *  catalog id is derived and can change, so a row filed under it can be orphaned. `keyKind` keeps
 *  that difference visible on the wire instead of pretending the two are equal. */
function triageKeyFor(entry: CatalogEntry): { key: string; keyKind: 'identifier' | 'catalog-id' } {
  const identifier = entry.identifiers?.[0];
  if (identifier) return { key: identifier, keyKind: 'identifier' };
  return { key: entry.id, keyKind: 'catalog-id' };
}

function isReport(entry: CatalogEntry, tags: readonly string[]): boolean {
  return entry.tags.some((t) => tags.includes(t));
}

/** Resolve a triage key back to its document. Every mutator goes through this rather than trusting
 *  the key it was handed: a key that matches no report document 404s, so triage can never be filed
 *  against something that is not a report (or is not there at all). */
function findReport(
  store: { listDocuments(): CatalogEntry[] },
  tags: readonly string[],
  key: string,
): CatalogEntry | undefined {
  return store.listDocuments().find((entry) => isReport(entry, tags) && triageKeyFor(entry).key === key);
}

/**
 * The one place a report's status is derived, so nothing can disagree with the list: a stored row
 * wins, else the document's own handled tag, else pending. Every caller — the list, the detail
 * route, and `process-pending`'s own pending filter — goes through {@link derivedStatus} below, so
 * turning auto mode on can never convert a report the queue was not showing as pending.
 */
function derivedStatus(
  entry: CatalogEntry,
  triage: ReportTriageRow | undefined,
  handledTags: readonly string[],
): { status: ReportStatus; statusSource: ReportStatusSource } {
  if (triage) return { status: triage.status, statusSource: 'triage' };
  // The document's own statement about itself. `approved` rather than `dismissed` because a
  // processed report in the source tracker had become work — but with NO row, because there is no
  // timestamp, reason or todo id here that would not be invented.
  if (entry.tags.some((t) => handledTags.includes(t))) return { status: 'approved', statusSource: 'document' };
  return { status: 'pending', statusSource: 'default' };
}

/** `keyKind` is deliberately NOT a field of the list item: it describes the row, and a report with
 *  no row has none. A client that needs it before triage reads it off the key it was given. */
function toListItem(
  entry: CatalogEntry,
  triage: ReportTriageRow | undefined,
  handledTags: readonly string[],
): ReportListItem {
  const { key } = triageKeyFor(entry);
  const { status, statusSource } = derivedStatus(entry, triage, handledTags);
  return {
    key,
    docId: entry.id,
    title: entry.title,
    // Spread conditionally: writing `domain: entry.domain` types a key as always-present that
    // `JSON.stringify` then drops when undefined, which is exactly the drift the parity guard
    // fails on.
    ...(entry.domain ? { domain: entry.domain } : {}),
    tags: [...entry.tags],
    ...(entry.updatedAt ? { filedAt: entry.updatedAt } : {}),
    status,
    statusSource,
    ...(triage ? { triage } : {}),
  };
}

/** Everything a report body says, as one string a todo can be seeded from. */
function seedWhatToDo(title: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return title;
  return trimmed;
}

export function createReportsRoutes(deps: ReportsRouteDeps = {}) {
  const loadReportsConfig = async (projectRoot: string): Promise<ReportsConfig> => {
    if (!deps.reportsConfig) return DEFAULT_REPORTS_CONFIG;
    // A config read that throws must not take the inbox down — the same degrade-to-default rule
    // `loadConfig` applies to a malformed file, applied to the injection too.
    return deps.reportsConfig(projectRoot).catch(() => DEFAULT_REPORTS_CONFIG);
  };

  /** Resolve which project's inbox an approval mints into, and that inbox's dataDir. Falls back to
   *  the report's own project, which is always a valid target. */
  async function resolveTodoTarget(
    requested: string | undefined,
    domain: string | undefined,
    routeByDomain: Readonly<Record<string, string>>,
    fallback: { id: string; dataDir: string },
  ): Promise<{ projectId: string; dataDir: string } | { error: string }> {
    const wanted = requested ?? (domain ? routeByDomain[domain] : undefined);
    if (!wanted || wanted === fallback.id) return { projectId: fallback.id, dataDir: fallback.dataDir };
    if (!deps.listProjects) {
      return { error: `cannot mint into project "${wanted}" — no project registry is available here` };
    }
    const projects = await deps.listProjects().catch(() => [] as readonly ReportsRouteProjectSource[]);
    const match = projects.find((p) => p.id === wanted);
    if (!match) return { error: `no such project: ${wanted}` };
    // The same hardcoded join every per-project reader uses (`workspace/todo-index.ts`).
    return { projectId: match.id, dataDir: join(match.root, '.ai', 'cezar') };
  }

  /**
   * Mint the todo for a report, or return the one that already exists.
   *
   * **Idempotency without a transaction across two files.** `approve` writes `todos.json` AND
   * `reports-triage.json`; a crash between them would leave a todo with no triage row, so the
   * report would read as pending and a second approve would mint a duplicate. Rather than invent a
   * two-file transaction, this scans the target inbox for a todo whose `context` already carries
   * this report key. That makes the operation idempotent on the only thing that matters — one
   * report, one todo — using state that is already durable.
   */
  async function mintOrReuseTodo(args: {
    key: string;
    dataDir: string;
    entry: CatalogEntry;
    body: string;
    priority?: 'high' | 'medium' | 'low';
    auto: boolean;
  }) {
    const marker = `report-key: ${args.key}`;
    const existing = (await readTodos(args.dataDir)).find((t) => t.context?.includes(marker));
    if (existing) return { todo: existing, reused: true as const };
    const todo = await createTodo(args.dataDir, {
      summary: args.entry.title,
      origin: 'composer',
      status: 'todo',
      ...(args.priority ? { priority: args.priority } : {}),
      context:
        `From a user report, triaged ${args.auto ? 'automatically' : 'in the cockpit'} on ` +
        `${new Date().toISOString().slice(0, 10)}.\n` +
        `${marker}\n` +
        `knowledge document: ${args.entry.id}` +
        (args.entry.domain ? `\ndomain: ${args.entry.domain}` : '') +
        (args.entry.updatedAt ? `\nfiled: ${args.entry.updatedAt}` : ''),
      whatToDo: seedWhatToDo(args.entry.title, args.body),
    });
    return { todo, reused: false as const };
  }

  return new Hono<ProjectApiEnv>()
    // ---- reads: 200 + schema-valid empty when off, never 404, never a write ------------------
    .get('/reports', queryZodValidator(reportsQuerySchema), async (c) => {
      const { root, dataDir, knowledgeStore } = c.get('project');
      if (!knowledgeStore) return c.json(EMPTY_REPORTS_RESPONSE);
      const { status, domain, limit, offset } = c.req.valid('query');
      const { tags, handledTags } = await loadReportsConfig(root);
      const triage = await readReportTriage(dataDir);
      const all = knowledgeStore
        .listDocuments()
        .filter((entry) => isReport(entry, tags))
        .map((entry) => toListItem(entry, triage.get(triageKeyFor(entry).key), handledTags));

      // Counts describe the WHOLE set, before status/domain filtering and before paging — a
      // filtered count would make the tab badges disagree with the tabs.
      const counts: ReportCounts = {
        pending: all.filter((i) => i.status === 'pending').length,
        approved: all.filter((i) => i.status === 'approved').length,
        dismissed: all.filter((i) => i.status === 'dismissed').length,
        total: all.length,
      };

      const filtered = all
        .filter((i) => (status ? i.status === status : true))
        .filter((i) => (domain ? i.domain === domain : true))
        // Pending first, then newest filed — the queue order, not the catalog's.
        .sort((a, b) => {
          if (a.status !== b.status) {
            if (a.status === 'pending') return -1;
            if (b.status === 'pending') return 1;
          }
          return (b.filedAt ?? '').localeCompare(a.filedAt ?? '') || a.key.localeCompare(b.key);
        });

      const start = offset ?? 0;
      const page = limit === undefined ? filtered.slice(start) : filtered.slice(start, start + limit);
      const body: ReportsResponse = {
        enabled: true,
        items: page,
        counts,
        truncated: start + page.length < filtered.length,
      };
      return c.json(body);
    })

    // Registered before `/reports/:key` so the literal segment is unambiguous to a reader. Hono
    // matches static ahead of param regardless, so this is for readability, not correctness.
    .post('/reports/process-pending', async (c) => {
      const { id, root, dataDir, knowledgeStore } = c.get('project');
      if (!knowledgeStore) return c.json({ error: REPORTS_OFF }, 409);
      const { tags, handledTags, auto, routeByDomain } = await loadReportsConfig(root);
      if (!auto) return c.json({ error: AUTO_OFF }, 409);

      const triage = await readReportTriage(dataDir);
      const pending = knowledgeStore
        .listDocuments()
        .filter((entry) => isReport(entry, tags))
        // `derivedStatus`, NOT `!triage.has(key)`. The two agreed until handled tags existed, and
        // the difference is 191 tasks on the real corpus: a report the queue shows as approved
        // because its own document says so must never be converted by an automatic pass.
        .filter((entry) => derivedStatus(entry, triage.get(triageKeyFor(entry).key), handledTags).status === 'pending');

      const outcomes: ReportProcessOutcome[] = [];
      for (const entry of pending) {
        const { key, keyKind } = triageKeyFor(entry);
        try {
          const target = await resolveTodoTarget(undefined, entry.domain, routeByDomain, { id, dataDir });
          if ('error' in target) {
            outcomes.push({ key, ok: false, error: target.error });
            continue;
          }
          const document = knowledgeStore.getDocument(entry.id);
          const { todo } = await mintOrReuseTodo({
            key,
            dataDir: target.dataDir,
            entry,
            body: document?.body ?? '',
            auto: true,
          });
          await updateReportTriage(dataDir, key, (current) =>
            current ?? {
              key,
              keyKind,
              status: 'approved',
              at: new Date().toISOString(),
              todoId: todo.id,
              todoProjectId: target.projectId,
              auto: true,
            },
          );
          outcomes.push({ key, ok: true, todoId: todo.id });
        } catch (err) {
          outcomes.push({ key, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      const body: ReportProcessPendingResponse = {
        outcomes,
        converted: outcomes.filter((o) => o.ok).length,
        failed: outcomes.filter((o) => !o.ok).length,
      };
      return c.json(body);
    })

    .get('/reports/:key', async (c) => {
      const { root, dataDir, knowledgeStore } = c.get('project');
      if (!knowledgeStore) return c.json(EMPTY_DETAIL_RESPONSE);
      const key = c.req.param('key');
      const { tags, handledTags } = await loadReportsConfig(root);
      const entry = findReport(knowledgeStore, tags, key);
      if (!entry) return c.json({ error: 'no such report' }, 404);
      const triage = await readReportTriage(dataDir);
      const document = knowledgeStore.getDocument(entry.id);
      const body: ReportDetailResponse = {
        enabled: true,
        item: toListItem(entry, triage.get(key), handledTags),
        body: document?.body ?? '',
      };
      return c.json(body);
    })

    // ---- mutators: real success branch when on, 409 when off ----------------------------------
    // `absent: {}` — every field of the approve body is optional, so "approve it where it belongs"
    // is a bodyless POST and must succeed. Dismiss deliberately does NOT get this: its reason is
    // required, so a bodyless dismiss has to 400 rather than quietly lose a report with no reason.
    .post('/reports/:key/approve', jsonZodValidator(approveReportInputSchema, { absent: {} }), async (c) => {
      const { id, root, dataDir, knowledgeStore } = c.get('project');
      if (!knowledgeStore) return c.json({ error: REPORTS_OFF }, 409);
      const key = c.req.param('key');
      const { tags, handledTags, routeByDomain } = await loadReportsConfig(root);
      const entry = findReport(knowledgeStore, tags, key);
      if (!entry) return c.json({ error: 'no such report' }, 404);

      const { todoProjectId, priority } = c.req.valid('json');
      const target = await resolveTodoTarget(todoProjectId, entry.domain, routeByDomain, { id, dataDir });
      if ('error' in target) return c.json({ error: target.error }, 400);

      const document = knowledgeStore.getDocument(entry.id);
      const { todo, reused } = await mintOrReuseTodo({
        key,
        dataDir: target.dataDir,
        entry,
        body: document?.body ?? '',
        ...(priority ? { priority } : {}),
        auto: false,
      });

      const { keyKind } = triageKeyFor(entry);
      const row = await updateReportTriage(dataDir, key, (current) => {
        // Re-approving keeps the FIRST approval's timestamp and todo — the record of when this was
        // triaged is not something a second click gets to overwrite.
        if (current?.status === 'approved') return current;
        return {
          key,
          keyKind,
          status: 'approved',
          at: new Date().toISOString(),
          todoId: todo.id,
          todoProjectId: target.projectId,
        };
      });

      const body: ReportApproveResponse = {
        item: toListItem(entry, row, handledTags),
        todo,
        alreadyApproved: reused,
      };
      return c.json(body);
    })

    .post('/reports/:key/dismiss', jsonZodValidator(dismissReportInputSchema), async (c) => {
      const { root, dataDir, knowledgeStore } = c.get('project');
      if (!knowledgeStore) return c.json({ error: REPORTS_OFF }, 409);
      const key = c.req.param('key');
      const { tags, handledTags } = await loadReportsConfig(root);
      const entry = findReport(knowledgeStore, tags, key);
      if (!entry) return c.json({ error: 'no such report' }, 404);
      const { reason } = c.req.valid('json');
      const { keyKind } = triageKeyFor(entry);
      const row = await updateReportTriage(dataDir, key, (current) => ({
        key,
        keyKind,
        status: 'dismissed',
        at: new Date().toISOString(),
        reason,
        // A dismissal after an approval keeps the todo pointer: the work exists, and losing the
        // link would make the todo unattributable.
        ...(current?.todoId ? { todoId: current.todoId } : {}),
        ...(current?.todoProjectId ? { todoProjectId: current.todoProjectId } : {}),
      }));
      const body: ReportDismissResponse = { item: toListItem(entry, row, handledTags) };
      return c.json(body);
    })

    .post('/reports/:key/reopen', async (c) => {
      const { root, dataDir, knowledgeStore } = c.get('project');
      if (!knowledgeStore) return c.json({ error: REPORTS_OFF }, 409);
      const key = c.req.param('key');
      const { tags, handledTags } = await loadReportsConfig(root);
      const entry = findReport(knowledgeStore, tags, key);
      if (!entry) return c.json({ error: 'no such report' }, 404);

      let orphanedTodoId: string | undefined;
      let orphanedTodoProjectId: string | undefined;
      await updateReportTriage(dataDir, key, (current) => {
        orphanedTodoId = current?.todoId;
        orphanedTodoProjectId = current?.todoProjectId;
        return undefined; // delete the row — absence IS pending
      });

      const body: ReportReopenResponse = {
        item: toListItem(entry, undefined, handledTags),
        // A todo minted by an earlier approve is NOT deleted: by now it may be started or done.
        // Named so the caller can decide rather than being silently left behind.
        ...(orphanedTodoId ? { orphanedTodoId } : {}),
        ...(orphanedTodoProjectId ? { orphanedTodoProjectId } : {}),
      };
      return c.json(body);
    });
}
