import { join } from 'node:path';
import { Hono, type Context } from 'hono';
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
import { readWorkspaceReportsConfig } from '../reports-config.ts';
import { readReportTriage, updateReportTriage } from '../reports-triage.ts';
import { createTodo, readTodos } from '../todos.ts';
import { listProjects } from '../workspace/projects.ts';
import {
  WorkspaceReportsIndex,
  reportTriageKeyFor,
  type WorkspaceReportRow,
  type WorkspaceReportsContexts,
  type WorkspaceReportsProjectSource,
} from '../workspace/reports-index.ts';
import { resolveCapabilities } from './capabilities.ts';
import { jsonZodValidator, queryZodValidator } from './validators.ts';
import type { Principal, ProjectApiEnv } from './server.ts';

/**
 * The REPORTS family of `/api/v1/workspace` — triage over the report documents in every registered
 * project's knowledge base. See `.ai/specs/2026-08-19-reports-triage-approve-dismiss.md` and its
 * "Reports is a workspace tab" amendment.
 *
 * **The list is a join, not a store.** Reports are knowledge documents carrying the reports tag;
 * this family adds no document type, no second index, and writes nothing on a read. A report with
 * no triage row and no handled tag of its own reads as `pending`, which is what lets a freshly
 * arrived report appear in the inbox the moment `fs.watch` indexes the file — no write anywhere.
 * See {@link derivedStatus} for why the document's own status tag is part of that derivation.
 *
 * **Why this family exists at all.** A report reaching the knowledge base is invisible on the Tasks
 * board, which renders `todos.json` and never reads the KB. That is not a bug to fix by teaching
 * the board about documents — the two stores have different jobs (the inbox is actionable, the
 * corpus is the archive). So triage is an explicit act that mints a todo, and this is where it
 * lives.
 *
 * **WORKSPACE-SCOPED, replacing the project-scoped family that shipped the same day.**
 * `./reports-routes.ts` is deleted, not kept alongside: two surfaces over one store is a second
 * place to make the same decision, which is the exact bug this change fixes. The measured failure —
 * a knowledge mount lives in the operator's `~/.cezar/config.json`, so 12 projects resolved the
 * same 196 reports, the tab rendered 12 identical queues, and two triage stores answered the same
 * questions twice — is in `../workspace/reports-index.ts`'s doc comment in full.
 *
 * **Gated on `capabilities.knowledge` ONLY — deliberately NOT the `knowledge && workspaceViews`
 * AND-gate its `./workspace-knowledge-routes.ts` sibling uses.** `workspaceViews` is false under
 * `CEZ_SINGLE_PROJECT=1`, and now that this is the only Reports surface, ANDing it in would delete
 * reports outright on a single-project install — a main path gated on a flag nobody sets is
 * invisible, failing as silence rather than as an error. `./workspace-todos-routes.ts` removed the
 * same gate for the same reason (its own D7 note). Reports ride the knowledge base, so `CEZ_KB=1`
 * is exactly the condition under which one can exist, and a second flag would let the two disagree.
 *
 * Reads answer 200 with a schema-valid empty payload when the gate is off; mutators answer 409
 * naming the flag. Never 404 for the gate — the feature is switched off, not missing; 404 is
 * reserved for a key that matches no report document.
 *
 * Workspace-level and single-mount — never mirrored under `/api/v1/p/:projectId`
 * (`BACKWARD_COMPATIBILITY.md` §2, the rule every sibling workspace family follows).
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

/** Every knob this family reads, resolved per request from `~/.cezar/config.json`. */
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

const EMPTY_COUNTS: ReportCounts = { pending: 0, approved: 0, dismissed: 0, total: 0 };

const EMPTY_REPORTS_RESPONSE: ReportsResponse = {
  enabled: false,
  items: [],
  counts: EMPTY_COUNTS,
  truncated: false,
  projects: [],
};

const EMPTY_DETAIL_RESPONSE: ReportDetailResponse = { enabled: false, item: null, body: '' };

export interface WorkspaceReportsRouteDeps {
  /** Injected rather than imported — importing `./project-context.ts` is exactly what the
   *  structural guard (`../workspace/reports-index.ts`'s own doc comment) forbids. */
  contexts: WorkspaceReportsContexts;
  /** Defaults to a fresh `WorkspaceReportsIndex` reading the real registry. Injected so tests hand
   *  it a hermetic fixture instead of `~/.cezar`. */
  reportsIndex?: WorkspaceReportsIndex;
  /** Registry lookup for resolving an approval's target inbox. Defaults to the real
   *  `listProjects()`. Separate from the index's own copy because it answers a different question:
   *  where a todo may be WRITTEN, not which corpora may be read. */
  listProjects?: () => Promise<readonly { id: string; root: string }[]>;
  /**
   * Resolve this family's config. Called PER REQUEST and never cached, for `loadConfig`'s own
   * stated reason: a snapshot of a file two cezar processes share is a staleness bug. Defaults to
   * the real `~/.cezar/config.json` reader.
   */
  reportsConfig?: () => Promise<ReportsConfig>;
}

function toIndexSource(project: {
  id: string;
  root: string;
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
  name: string;
}): WorkspaceReportsProjectSource {
  return { id: project.id, root: project.root, status: project.status, name: project.name || '' };
}

function defaultReportsIndex(contexts: WorkspaceReportsContexts): WorkspaceReportsIndex {
  return new WorkspaceReportsIndex({
    contexts,
    listProjects: async () => (await listProjects()).map(toIndexSource),
  });
}

/** The real config read, folded onto this family's defaults. An explicit `"tags": []` is respected
 *  as the opt-out it reads like (the `skillsRepos: []` precedent), NOT quietly replaced by the
 *  defaults — so a deployment can switch reports off by naming no tag. Only an ABSENT key falls
 *  back. */
async function defaultReportsConfig(): Promise<ReportsConfig> {
  const reports = await readWorkspaceReportsConfig();
  return {
    tags: reports.tags ?? DEFAULT_REPORT_TAGS,
    handledTags: reports.handledTags ?? DEFAULT_HANDLED_TAGS,
    // The env flag is the deployment-wide switch, the config key the workspace one; either turns it
    // on. `=== '1'` exactly, matching every other `CEZ_*` gate.
    auto: reports.auto ?? process.env.CEZ_REPORTS_AUTO === '1',
    routeByDomain: reports.routeByDomain ?? {},
  };
}

/** True when the knowledge base is on. Read per request, never snapshotted at construction — the
 *  same discipline every other capability gate in this directory follows. */
function knowledgeOn(): boolean {
  return resolveCapabilities(process.env).knowledge;
}

/**
 * The one place a report's status is derived, so nothing can disagree with the list: a stored row
 * wins, else the document's own handled tag, else pending. Every caller — the list, the detail
 * route, and `process-pending`'s own pending filter — goes through this, so turning auto mode on can
 * never convert a report the queue was not showing as pending.
 */
function derivedStatus(
  row: WorkspaceReportRow,
  triage: ReportTriageRow | undefined,
  handledTags: readonly string[],
): { status: ReportStatus; statusSource: ReportStatusSource } {
  if (triage) return { status: triage.status, statusSource: 'triage' };
  // The document's own statement about itself. `approved` rather than `dismissed` because a
  // processed report in the source tracker had become work — but with NO row, because there is no
  // timestamp, reason or todo id here that would not be invented.
  if (row.entry.tags.some((t) => handledTags.includes(t))) return { status: 'approved', statusSource: 'document' };
  return { status: 'pending', statusSource: 'default' };
}

/**
 * Who to stamp on a row's `by` — the signed-in user's id, or `undefined` when there is no signed-in
 * user to name.
 *
 * Read through a cast rather than by widening {@link ProjectApiEnv}, which is what `server.ts`'s
 * existing principal readers do and for the reason its own comment gives: widening the env broke
 * assignability for the ~30 callers that annotate a plain `Hono`.
 *
 * **`kind === 'local'` deliberately yields nothing.** The contract says `by` is absent on an
 * unauthenticated deployment, and `CEZ_AUTH=none`'s implicit identity is the machine, not a person —
 * stamping it would make "whoever was at this laptop" read in the audit trail exactly like a named
 * colleague's decision.
 */
function triagedBy(c: Context<ProjectApiEnv>): string | undefined {
  const withPrincipal = c as unknown as Context<{ Variables: { principal: Principal } }>;
  const principal = withPrincipal.get('principal') as Principal | undefined;
  return principal?.kind === 'session' ? principal.userId : undefined;
}

/** `keyKind` is deliberately NOT a field of the list item: it describes the row, and a report with
 *  no row has none. A client that needs it before triage reads it off the key it was given. */
function toListItem(
  row: WorkspaceReportRow,
  triage: ReportTriageRow | undefined,
  handledTags: readonly string[],
): ReportListItem {
  const { status, statusSource } = derivedStatus(row, triage, handledTags);
  return {
    key: row.key,
    docId: row.entry.id,
    project: row.project,
    projects: row.projects,
    title: row.entry.title,
    // Spread conditionally: writing `domain: entry.domain` types a key as always-present that
    // `JSON.stringify` then drops when undefined, which is exactly the drift the parity guard
    // fails on.
    ...(row.entry.domain ? { domain: row.entry.domain } : {}),
    tags: [...row.entry.tags],
    ...(row.entry.updatedAt ? { filedAt: row.entry.updatedAt } : {}),
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

export function createWorkspaceReportsRoutes(deps: WorkspaceReportsRouteDeps) {
  const index = deps.reportsIndex ?? defaultReportsIndex(deps.contexts);
  const projectRegistry = deps.listProjects ?? (async () => (await listProjects()).map((p) => ({ id: p.id, root: p.root })));

  const loadReportsConfig = async (): Promise<ReportsConfig> => {
    const load = deps.reportsConfig ?? defaultReportsConfig;
    // A config read that throws must not take the inbox down — the same degrade-to-default rule
    // `loadConfig` applies to a malformed file, applied to the injection too.
    return load().catch(() => ({
      tags: DEFAULT_REPORT_TAGS,
      handledTags: DEFAULT_HANDLED_TAGS,
      auto: false,
      routeByDomain: {},
    }));
  };

  /**
   * Resolve which project's inbox an approval mints into, and that inbox's dataDir.
   *
   * Order: the caller's explicit `todoProjectId`, then the workspace routing map keyed on the
   * report's `domain`, then the row's CANONICAL project. That last fallback is the cross-project
   * answer the per-project design claimed did not exist: a workspace mount has no owning repo, so
   * "the report's own project" is not a fact — the canonical project is a deterministic pick
   * (registry order), and `routeByDomain` is where the operator says what it should really be.
   */
  async function resolveTodoTarget(
    requested: string | undefined,
    domain: string | undefined,
    routeByDomain: Readonly<Record<string, string>>,
    fallbackProjectId: string,
  ): Promise<{ projectId: string; dataDir: string } | { error: string }> {
    const wanted = requested ?? (domain ? routeByDomain[domain] : undefined) ?? fallbackProjectId;
    const projects = await projectRegistry().catch(() => [] as readonly { id: string; root: string }[]);
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
    row: WorkspaceReportRow;
    body: string;
    priority?: 'high' | 'medium' | 'low';
    auto: boolean;
  }) {
    const marker = `report-key: ${args.key}`;
    const existing = (await readTodos(args.dataDir)).find((t) => t.context?.includes(marker));
    if (existing) return { todo: existing, reused: true as const };
    const todo = await createTodo(args.dataDir, {
      summary: args.row.entry.title,
      origin: 'composer',
      status: 'todo',
      ...(args.priority ? { priority: args.priority } : {}),
      context:
        `From a user report, triaged ${args.auto ? 'automatically' : 'in the cockpit'} on ` +
        `${new Date().toISOString().slice(0, 10)}.\n` +
        `${marker}\n` +
        `knowledge document: ${args.row.entry.id}` +
        (args.row.entry.domain ? `\ndomain: ${args.row.entry.domain}` : '') +
        (args.row.entry.updatedAt ? `\nfiled: ${args.row.entry.updatedAt}` : ''),
      whatToDo: seedWhatToDo(args.row.entry.title, args.body),
    });
    return { todo, reused: false as const };
  }

  return new Hono<ProjectApiEnv>()
    // ---- reads: 200 + schema-valid empty when off, never 404, never a write ------------------
    .get('/workspace/reports', queryZodValidator(reportsQuerySchema), async (c) => {
      if (!knowledgeOn()) return c.json(EMPTY_REPORTS_RESPONSE);
      const { status, domain, project, limit, offset } = c.req.valid('query');
      const { tags, handledTags } = await loadReportsConfig();
      const triage = await readReportTriage();
      const { rows, projects } = await index.list({ tags });
      const all = rows.map((row) => toListItem(row, triage.get(row.key), handledTags));

      // Counts describe the WHOLE set, before status/domain/project filtering and before paging — a
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
        // MEMBERSHIP, not equality against `project`: a row belongs to every project that resolves
        // it, and filtering on the canonical one alone would hide a shared report from the other
        // eleven — which is the per-project blindness this whole page exists to end.
        .filter((i) => (project ? i.projects.includes(project) : true))
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
        projects,
      };
      return c.json(body);
    })

    // Registered before `/workspace/reports/:key` so the literal segment is unambiguous to a reader.
    // Hono matches static ahead of param regardless, so this is for readability, not correctness.
    .post('/workspace/reports/process-pending', async (c) => {
      if (!knowledgeOn()) return c.json({ error: REPORTS_OFF }, 409);
      const { tags, handledTags, auto, routeByDomain } = await loadReportsConfig();
      if (!auto) return c.json({ error: AUTO_OFF }, 409);

      const triage = await readReportTriage();
      // ONE fan-out for the whole pass, bodies served from it (`WorkspaceReportsListResult.body`).
      // Resolving each body through a fresh `index.find()` would re-scan every project's knowledge
      // store once per report — 196 × 12 on the deployment this was measured on.
      const listed = await index.list({ tags });
      const pending = listed.rows.filter(
        // `derivedStatus`, NOT `!triage.has(key)`. The two agreed until handled tags existed, and
        // the difference is 191 tasks on the real corpus: a report the queue shows as approved
        // because its own document says so must never be converted by an automatic pass.
        (row) => derivedStatus(row, triage.get(row.key), handledTags).status === 'pending',
      );

      // Stamped even though every row this pass writes carries `auto: true`: the pass did the
      // converting, but a person asked for it, and "who turned 40 reports into tasks" is exactly the
      // question an audit trail exists to answer. `auto` is what keeps the two distinguishable.
      const by = triagedBy(c);
      const outcomes: ReportProcessOutcome[] = [];
      for (const row of pending) {
        try {
          const target = await resolveTodoTarget(undefined, row.entry.domain, routeByDomain, row.project);
          if ('error' in target) {
            outcomes.push({ key: row.key, ok: false, error: target.error });
            continue;
          }
          const { todo } = await mintOrReuseTodo({
            key: row.key,
            dataDir: target.dataDir,
            row,
            body: listed.body(row.key),
            auto: true,
          });
          await updateReportTriage(row.key, (current) =>
            current ?? {
              key: row.key,
              keyKind: row.keyKind,
              status: 'approved',
              at: new Date().toISOString(),
              ...(by ? { by } : {}),
              todoId: todo.id,
              todoProjectId: target.projectId,
              auto: true,
            },
          );
          outcomes.push({ key: row.key, ok: true, todoId: todo.id });
        } catch (err) {
          outcomes.push({ key: row.key, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      const body: ReportProcessPendingResponse = {
        outcomes,
        converted: outcomes.filter((o) => o.ok).length,
        failed: outcomes.filter((o) => !o.ok).length,
      };
      return c.json(body);
    })

    .get('/workspace/reports/:key', async (c) => {
      if (!knowledgeOn()) return c.json(EMPTY_DETAIL_RESPONSE);
      const key = c.req.param('key');
      const { tags, handledTags } = await loadReportsConfig();
      const found = await index.find(key, { tags });
      if (!found) return c.json({ error: 'no such report' }, 404);
      const triage = await readReportTriage();
      const body: ReportDetailResponse = {
        enabled: true,
        item: toListItem(found.row, triage.get(key), handledTags),
        body: found.body,
      };
      return c.json(body);
    })

    // ---- mutators: real success branch when on, 409 when off ----------------------------------
    // `absent: {}` — every field of the approve body is optional, so "approve it where it belongs"
    // is a bodyless POST and must succeed. Dismiss deliberately does NOT get this: its reason is
    // required, so a bodyless dismiss has to 400 rather than quietly lose a report with no reason.
    .post('/workspace/reports/:key/approve', jsonZodValidator(approveReportInputSchema, { absent: {} }), async (c) => {
      if (!knowledgeOn()) return c.json({ error: REPORTS_OFF }, 409);
      const key = c.req.param('key');
      const { tags, handledTags, routeByDomain } = await loadReportsConfig();
      const found = await index.find(key, { tags });
      if (!found) return c.json({ error: 'no such report' }, 404);

      const { todoProjectId, priority } = c.req.valid('json');
      const target = await resolveTodoTarget(todoProjectId, found.row.entry.domain, routeByDomain, found.row.project);
      if ('error' in target) return c.json({ error: target.error }, 400);

      const { todo, reused } = await mintOrReuseTodo({
        key,
        dataDir: target.dataDir,
        row: found.row,
        body: found.body,
        ...(priority ? { priority } : {}),
        auto: false,
      });

      const by = triagedBy(c);
      const row = await updateReportTriage(key, (current) => {
        // Re-approving keeps the FIRST approval's timestamp, todo AND author — the record of who
        // triaged this and when is not something a second click gets to overwrite. At workspace
        // scope that also means a second click FROM ANOTHER PROJECT'S TAB cannot overwrite it,
        // which is the case that produced two contradicting stores on the box.
        if (current?.status === 'approved') return current;
        return {
          key,
          keyKind: found.row.keyKind,
          status: 'approved',
          at: new Date().toISOString(),
          ...(by ? { by } : {}),
          todoId: todo.id,
          todoProjectId: target.projectId,
        };
      });

      const body: ReportApproveResponse = {
        item: toListItem(found.row, row, handledTags),
        todo,
        alreadyApproved: reused,
      };
      return c.json(body);
    })

    .post('/workspace/reports/:key/dismiss', jsonZodValidator(dismissReportInputSchema), async (c) => {
      if (!knowledgeOn()) return c.json({ error: REPORTS_OFF }, 409);
      const key = c.req.param('key');
      const { tags, handledTags } = await loadReportsConfig();
      const found = await index.find(key, { tags });
      if (!found) return c.json({ error: 'no such report' }, 404);
      const { reason } = c.req.valid('json');
      const by = triagedBy(c);
      const row = await updateReportTriage(key, (current) => ({
        key,
        keyKind: found.row.keyKind,
        status: 'dismissed',
        at: new Date().toISOString(),
        // Unlike approve, a dismissal DOES overwrite `by`: it is a fresh decision to drop a report,
        // and the person accountable for it is whoever dismissed it, not whoever approved it first.
        ...(by ? { by } : {}),
        reason,
        // A dismissal after an approval keeps the todo pointer: the work exists, and losing the
        // link would make the todo unattributable.
        ...(current?.todoId ? { todoId: current.todoId } : {}),
        ...(current?.todoProjectId ? { todoProjectId: current.todoProjectId } : {}),
      }));
      const body: ReportDismissResponse = { item: toListItem(found.row, row, handledTags) };
      return c.json(body);
    })

    .post('/workspace/reports/:key/reopen', async (c) => {
      if (!knowledgeOn()) return c.json({ error: REPORTS_OFF }, 409);
      const key = c.req.param('key');
      const { tags, handledTags } = await loadReportsConfig();
      const found = await index.find(key, { tags });
      if (!found) return c.json({ error: 'no such report' }, 404);

      let orphanedTodoId: string | undefined;
      let orphanedTodoProjectId: string | undefined;
      await updateReportTriage(key, (current) => {
        orphanedTodoId = current?.todoId;
        orphanedTodoProjectId = current?.todoProjectId;
        return undefined; // delete the row — absence IS pending
      });

      const body: ReportReopenResponse = {
        item: toListItem(found.row, undefined, handledTags),
        // A todo minted by an earlier approve is NOT deleted: by now it may be started or done.
        // Named so the caller can decide rather than being silently left behind.
        ...(orphanedTodoId ? { orphanedTodoId } : {}),
        ...(orphanedTodoProjectId ? { orphanedTodoProjectId } : {}),
      };
      return c.json(body);
    });
}

export { reportTriageKeyFor };
