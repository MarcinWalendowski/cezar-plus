import { z } from 'zod';
import { todoItemSchema } from './skills.ts';
import { workspaceProjectHealthSchema } from './workspace-runs.ts';

/**
 * The REPORTS family of `/api/v1/workspace` — triage over the report documents in the knowledge
 * bases of every registered project. See `.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`
 * and its "Reports is a workspace tab" amendment.
 *
 * A report is an ordinary knowledge document carrying the reports tag; presence of that tag is
 * what makes it one, exactly as `changeType` is what makes a document a changelog entry
 * (`./knowledge.ts`). This family adds **no** document type and **no** new index: the list is a
 * left join of "documents carrying the tag" against one small triage store, and a report with
 * neither a triage row nor a handled tag of its own reads as `pending`. That is why a freshly
 * arrived report needs no write anywhere to appear in the inbox — and why a report the previous
 * tracker already processed does not reappear as a question (see
 * {@link reportStatusSourceSchema}).
 *
 * **WORKSPACE-SCOPED, and that is the whole point (CHANGED 2026-08-19).** This used to be
 * `/api/v1/reports`, mounted per project. It could not stay there: a knowledge mount is declared
 * in the OPERATOR's `~/.cezar/config.json` (`.ai/specs/2026-08-19-tasks-page-and-start-
 * grounding.md` D3), so on the deployment that motivated this every one of 12 projects resolved
 * the same 196 reports — 12 identical queues, each with its own triage store, each able to answer
 * the same question differently. Measured, not hypothetical: two stores existed on the box and the
 * second one re-dismissed two reports the first had already decided. One queue, one decision.
 *
 * **Triage never lives in the report's own frontmatter.** Report documents arrive from a mount
 * that may be read-only, they are owned by whatever writer drains them (which re-writes the same
 * filename on retry), and their bodies are end-user text. A second writer editing their
 * frontmatter would turn a safe re-drain into a clobber. So triage is a separate store, keyed on
 * the document's provenance identifier — and that key is what makes ONE store at workspace scope
 * safe: an identifier is globally unique, so two projects with genuinely different reports cannot
 * collide (see {@link reportKeyKindSchema} for the weaker fallback key, which stays visibly
 * weaker).
 *
 * As in `./knowledge.ts`, these shapes are the CLOSED wire half — every key a route answers with
 * and no index signature. `contract-parity.reports.test.ts` checks each response schema against
 * the route that serves it, in both directions.
 *
 * **Flag-off shape.** Reports ride on the knowledge base, so with `CEZ_KB` unset every `GET`
 * answers 200 with a schema-valid empty payload and every mutator answers 409 — never 404,
 * because the feature is switched off, not missing. The schemas below are shaped so the empty
 * payload is a normal value of the same type as the "on" response, never a second shape.
 * `capabilities.workspaceViews` is deliberately NOT part of that gate, unlike the workspace
 * KNOWLEDGE family's AND-gate: it is false under `CEZ_SINGLE_PROJECT=1`, and since this is now the
 * ONLY reports surface, ANDing it in would delete reports outright on a single-project install.
 */

// ---- shared vocabulary -----------------------------------------------------------------------

/**
 * `pending` is DERIVED — the absence of a triage row — and is never a stored value. It appears
 * here because it is a value of the wire field; a client filtering `?status=pending` is asking
 * for reports with no row, not for rows whose status says "pending".
 */
export const reportStatusSchema = z.enum(['pending', 'approved', 'dismissed']);
export type ReportStatus = z.infer<typeof reportStatusSchema>;

/** Only these two are ever written; `pending` is the absence of a row. */
export const reportTriageStatusSchema = z.enum(['approved', 'dismissed']);
export type ReportTriageStatus = z.infer<typeof reportTriageStatusSchema>;

/**
 * Which kind of key the triage row is filed under, carried on the wire so a weaker key is
 * VISIBLE rather than assumed. `identifier` is the document's own provenance id, minted once by
 * the writer and stable across reindexes; `catalog-id` is the fallback for a document that
 * carries no identifier, and it can change when the catalog is rebuilt — meaning triage on such
 * a report can be orphaned. A client may warn on it; nothing here pretends the two are equal.
 */
export const reportKeyKindSchema = z.enum(['identifier', 'catalog-id']);
export type ReportKeyKind = z.infer<typeof reportKeyKindSchema>;

/**
 * WHERE a report's `status` came from — carried on the wire because the three sources are not
 * interchangeable and a client that cannot tell them apart will mislead its reader.
 *
 * - `triage` — a real row in this project's triage store: somebody decided this, here, and the row
 *   says when and (for a dismissal) why.
 * - `document` — the report document's own status tag says it was already handled, by whatever
 *   tracker filed it, before this feature existed. There is no row, no timestamp we could honestly
 *   claim, and no todo to point at. It is NOT an approval, it is a report that is not asking a
 *   question any more.
 * - `default` — no row and no such tag: pending.
 *
 * This distinction exists because of a measured corpus, not a hypothetical: 191 of its 193 reports
 * carried `status/processed` from the tracker they were migrated out of. Deriving pending from "no
 * triage row" alone would open the queue on all 193 and re-ask 191 questions someone already
 * answered — and worse, an automatic pass would mint 191 tasks.
 */
export const reportStatusSourceSchema = z.enum(['triage', 'document', 'default']);
export type ReportStatusSource = z.infer<typeof reportStatusSourceSchema>;

// ---- the triage row --------------------------------------------------------------------------

export const reportTriageRowSchema = z.object({
  key: z.string().min(1).max(500),
  keyKind: reportKeyKindSchema,
  status: reportTriageStatusSchema,
  /** Server-stamped, never client-supplied. */
  at: z.string(),
  /**
   * The **user id** of the signed-in principal who triaged this, when auth is on — not their email
   * or display name, which live in the identity store a project-scoped route has no business
   * reading. Absent on an unauthenticated deployment (`CEZ_AUTH=none`'s identity is the machine, not
   * a person) and on a row written before this field was populated.
   *
   * Approve keeps the FIRST approver on a re-approve; dismiss overwrites, because dropping a report
   * is a fresh decision with a fresh owner. `process-pending` stamps whoever ran the pass and marks
   * the row `auto: true`, so "converted by a batch" stays distinguishable from "decided one by one".
   *
   * **Nothing renders this yet.** It is an audit field in the store and on the wire; the cockpit
   * shows the timestamp and the reason, and would need to resolve an id to a name to show an author.
   * Do not read its absence from the UI as the field being unused.
   */
  by: z.string().max(320).optional(),
  /** Required for `dismissed`, meaningless for `approved` — enforced by the input schemas, not
   *  here, because a stored row read back must never fail validation over a rule that changed. */
  reason: z.string().max(500).optional(),
  /** Set by approve: the todo this report became. */
  todoId: z.string().min(1).optional(),
  /** Which project's inbox that todo landed in. */
  todoProjectId: z.string().min(1).optional(),
  /** True when `process-pending` created the row rather than a person. */
  auto: z.boolean().optional(),
});
export type ReportTriageRow = z.infer<typeof reportTriageRowSchema>;

// ---- the derived list item -------------------------------------------------------------------

export const reportListItemSchema = z.object({
  /** The triage key — what every mutator addresses this report by. Workspace-unique: the queue is
   *  DEDUPED on it, so one document resolved by twelve projects is one row here, not twelve. */
  key: z.string().min(1).max(500),
  /** The knowledge catalog id, for fetching the document body. */
  docId: z.string().min(1),
  /**
   * The registry id of the project this row's document link resolves through — the first project in
   * registry order that resolves it. Never "the project that owns this report": a workspace
   * knowledge mount belongs to the operator, not to any repo.
   *
   * **Stable once every project's store is warm, and NOT before (CORRECTED 2026-08-19).** This said
   * "so two identical requests name the same one", full stop, which the deployment disproved: both
   * this and `projects` are derived from the projects that answered within the server's per-project
   * deadline, and a cold store may miss it. Read `projects` in the response envelope to tell the two
   * apart — a row whose membership looks short while some project reports `ok: false` is a warmup
   * artifact, not a fact about the corpus.
   */
  project: z.string().min(1),
  /**
   * Every project whose knowledge base resolves this same document AND answered within the
   * deadline, sorted, `project` included. Length > 1 is the normal case for a workspace mount and is
   * exactly what the old per-project queue rendered as N separate rows with N separate answers.
   */
  projects: z.array(z.string()),
  title: z.string(),
  domain: z.string().optional(),
  tags: z.array(z.string()),
  /** The document's `updatedAt` — when the report was filed, not when it was indexed. */
  filedAt: z.string().optional(),
  status: reportStatusSchema,
  /** Where `status` came from — see {@link reportStatusSourceSchema}. Read this before showing a
   *  status as somebody's decision: `document` means nobody decided it here. */
  statusSource: reportStatusSourceSchema,
  /**
   * The stored triage row, present exactly when `statusSource` is `triage`.
   *
   * **CORRECTED 2026-08-19.** This said "absent exactly when `status` is `pending`", which stopped
   * being true the moment `statusSource: 'document'` existed: such a report is `approved` with NO
   * row, because there is nothing to store that would not be invented. Key the presence check on
   * `statusSource`, never on `status`.
   */
  triage: reportTriageRowSchema.optional(),
});
export type ReportListItem = z.infer<typeof reportListItemSchema>;

export const reportCountsSchema = z.object({
  pending: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  dismissed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type ReportCounts = z.infer<typeof reportCountsSchema>;

// ---- responses -------------------------------------------------------------------------------

export const reportsResponseSchema = z.object({
  enabled: z.boolean(),
  items: z.array(reportListItemSchema),
  counts: reportCountsSchema,
  /** True when `limit` cut the list short, so a caller never reads a page as the whole set. */
  truncated: z.boolean(),
  /**
   * One row per project the fan-out considered, dead ones included with `ok: false` and a reason —
   * the same `workspaceProjectHealthSchema` every sibling workspace board reports, reused rather
   * than re-declared. A project that fails is a ROW, never a silently dropped one: a corpus that
   * vanished would otherwise read as "nothing to triage", which is the opposite of true. `total`
   * is that project's own report count BEFORE the cross-project dedupe, so the numbers deliberately
   * sum to more than `counts.total` whenever a mount is shared.
   */
  projects: z.array(workspaceProjectHealthSchema),
});
export type ReportsResponse = z.infer<typeof reportsResponseSchema>;

export const reportDetailResponseSchema = z.object({
  enabled: z.boolean(),
  item: reportListItemSchema.nullable(),
  /** The document's markdown body. Never edited by this family. */
  body: z.string(),
});
export type ReportDetailResponse = z.infer<typeof reportDetailResponseSchema>;

export const reportApproveResponseSchema = z.object({
  item: reportListItemSchema,
  todo: todoItemSchema,
  /** True when an already-approved report was re-approved and the existing todo was returned
   *  instead of a second one being minted. */
  alreadyApproved: z.boolean(),
});
export type ReportApproveResponse = z.infer<typeof reportApproveResponseSchema>;

export const reportDismissResponseSchema = z.object({
  item: reportListItemSchema,
});
export type ReportDismissResponse = z.infer<typeof reportDismissResponseSchema>;

export const reportReopenResponseSchema = z.object({
  item: reportListItemSchema,
  /**
   * A todo minted by an earlier approve is NOT deleted by reopen — it is real work by then, and
   * possibly already started. Named here so the caller can decide, rather than being silently
   * left behind.
   */
  orphanedTodoId: z.string().min(1).optional(),
  orphanedTodoProjectId: z.string().min(1).optional(),
});
export type ReportReopenResponse = z.infer<typeof reportReopenResponseSchema>;

export const reportProcessOutcomeSchema = z.object({
  key: z.string().min(1).max(500),
  ok: z.boolean(),
  todoId: z.string().min(1).optional(),
  /** Why this one was not converted. Present exactly when `ok` is false. */
  error: z.string().max(500).optional(),
});
export type ReportProcessOutcome = z.infer<typeof reportProcessOutcomeSchema>;

export const reportProcessPendingResponseSchema = z.object({
  /** Every pending report the pass touched, in order, successes and failures alike — a caller
   *  must be able to see what a batch dropped, never infer completeness from a count. */
  outcomes: z.array(reportProcessOutcomeSchema),
  converted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type ReportProcessPendingResponse = z.infer<typeof reportProcessPendingResponseSchema>;

// ---- inputs ----------------------------------------------------------------------------------

export const reportsQuerySchema = z.object({
  status: reportStatusSchema.optional(),
  domain: z.string().trim().min(1).max(64).optional(),
  /** Keep only rows whose `projects` CONTAINS this registry id — a membership test, not equality
   *  against `project`, because a row belongs to every project that resolves it and filtering on
   *  the canonical one alone would hide a shared report from all but one of them. */
  project: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});
export type ReportsQuery = z.infer<typeof reportsQuerySchema>;

export const approveReportInputSchema = z.object({
  /** Which project's todo inbox to mint into. Omitted = the routing map, then the report's own
   *  project. */
  todoProjectId: z.string().min(1).max(200).optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
});
export type ApproveReportInput = z.infer<typeof approveReportInputSchema>;

/** A dismissal without a reason is a report quietly lost, so the reason is required — the one
 *  field this family refuses to make optional. */
export const dismissReportInputSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type DismissReportInput = z.infer<typeof dismissReportInputSchema>;
