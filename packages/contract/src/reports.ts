import { z } from 'zod';
import { todoItemSchema } from './skills.ts';

/**
 * The REPORTS family of `/api/v1` — triage over the report documents already in a project's
 * knowledge base. See `.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`.
 *
 * A report is an ordinary knowledge document carrying the reports tag; presence of that tag is
 * what makes it one, exactly as `changeType` is what makes a document a changelog entry
 * (`./knowledge.ts`). This family adds **no** document type and **no** new index: the list is a
 * left join of "documents carrying the tag" against a small per-project triage store, and a
 * report with neither a triage row nor a handled tag of its own reads as `pending`. That is why a
 * freshly arrived report needs no write anywhere to appear in the inbox — and why a report the
 * previous tracker already processed does not reappear as a question (see
 * {@link reportStatusSourceSchema}).
 *
 * **Triage never lives in the report's own frontmatter.** Report documents arrive from a mount
 * that may be read-only, they are owned by whatever writer drains them (which re-writes the same
 * filename on retry), and their bodies are end-user text. A second writer editing their
 * frontmatter would turn a safe re-drain into a clobber. So triage is a separate store, keyed on
 * the document's provenance identifier.
 *
 * As in `./knowledge.ts`, these shapes are the CLOSED wire half — every key a route answers with
 * and no index signature. `contract-parity.reports.test.ts` checks each response schema against
 * the route that serves it, in both directions.
 *
 * **Flag-off shape.** Reports ride on the knowledge base, so with `CEZ_KB` unset every `GET`
 * answers 200 with a schema-valid empty payload and every mutator answers 409 — never 404,
 * because the feature is switched off, not missing. The schemas below are shaped so the empty
 * payload is a normal value of the same type as the "on" response, never a second shape.
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
  /** The principal who triaged, when auth is on. Absent on an unauthenticated deployment. */
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
  /** The triage key — what every mutator addresses this report by. */
  key: z.string().min(1).max(500),
  /** The knowledge catalog id, for fetching the document body. */
  docId: z.string().min(1),
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
