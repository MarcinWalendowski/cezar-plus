import { z } from 'zod';
import { todoItemSchema } from './skills.ts';
import { workspaceProjectHealthSchema } from './workspace-runs.ts';

/**
 * `GET /api/v1/workspace/todos` — the cross-project todo board (D2 of
 * `.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`, Phase 1): a fan-out that wrote a task
 * into several projects is visible in one place instead of one project's own `/todos` at a time.
 *
 * Same family shape as `./workspace-runs.ts`/`./workspace-knowledge.ts`: `workspaceProjectHealthSchema`
 * is reused as-is rather than re-declared, so a dead or missing project renders identically across
 * every workspace board.
 *
 * **CORRECTED 2026-08-15 — this route is not flag-gated at all.** The paragraph below said an
 * install with `CEZ_FOLLOWUPS` / `CEZ_WORKSPACE_VIEWS` unset gets "a schema-valid empty payload".
 * D7a made that false: both flags are off on a default install and the composer files through
 * these same todo stores, so an empty answer would have hidden the user's own filed work on
 * exactly the installs the fan-out serves. The route answers with the real todos regardless of
 * either flag, which is what the Tasks board's Filed section reads
 * (`web/src/routes/global-tasks.tsx`). `CEZ_FOLLOWUPS` still gates **generation** — whether agents
 * are asked to leave follow-ups — and nothing else.
 *
 * Superseded text, kept for the reader who remembers it: *"**Flag-off shape.** With
 * `CEZ_FOLLOWUPS` or `CEZ_WORKSPACE_VIEWS` unset (or `CEZ_SINGLE_PROJECT=1`, which reports
 * `workspaceViews` false), `GET /workspace/todos` answers 200 with a schema-valid empty payload —
 * never 404."* Still true and unchanged: it is read-only, so there is no mutator to 409, and it
 * never 404s.
 */

/** One todo, stamped with the registry slug of the project it lives in. */
export const workspaceTodoEntrySchema = z.object({
  project: z.string(),
  todo: todoItemSchema,
});
export type WorkspaceTodoEntry = z.infer<typeof workspaceTodoEntrySchema>;


// ---- Partitioned, ordered, paged reads (2026-08-25-split-active-backlog-tables.md) ------------

/**
 * The Filed section's two tables: **Active** (every filed task whose status is not `todo`) and
 * **Backlog** (status `todo`, including an entry that carries no status at all — absent reads as
 * `'todo'`, the same read-time default the board has always painted).
 *
 * This is a partition INSIDE the page's Active tab (D1), not a replacement for the tab axis: the
 * tab asks "has this left the live board" (`archivedAt`, or `done`), this asks "is it in flight or
 * waiting". Both narrow the same list, on different questions.
 */
export const filedPartitionSchema = z.enum(['active', 'backlog']);
export type FiledPartition = z.infer<typeof filedPartitionSchema>;

/**
 * The sortable columns. **`node` is deliberately absent**: it renders only when the cockpit is
 * clustered, so `?sort=node` would be a URL that means something on one install and nothing on
 * the next. The selection checkbox and the actions column carry no value to sort on.
 */
export const filedSortColumnSchema = z.enum(['age', 'status', 'priority', 'task', 'project', 'author']);
export type FiledSortColumn = z.infer<typeof filedSortColumnSchema>;

export const filedSortDirSchema = z.enum(['asc', 'desc']);
export type FiledSortDir = z.infer<typeof filedSortDirSchema>;

/** The Active/Archived tab axis, unchanged — spelled here so the server can apply it. */
export const filedViewSchema = z.enum(['active', 'archived']);
export type FiledViewValue = z.infer<typeof filedViewSchema>;

/** Newest first — the same default every other list in this cockpit opens on. */
export const DEFAULT_FILED_SORT_COLUMN: FiledSortColumn = 'age';
export const DEFAULT_FILED_SORT_DIR: FiledSortDir = 'desc';

/**
 * Row counts, declared HERE rather than in the web package, so the server's `limit` bound and the
 * client's request are one number instead of twins free to drift.
 *
 * `FILED_ROW_PAGE_SIZE = 100` (`web/src/lib/filed-tasks.ts`) is untouched and still owns the
 * unsplit Archived table, which stays on the client-side path.
 */
export const FILED_ACTIVE_INITIAL_ROWS = 20;
export const FILED_BACKLOG_INITIAL_ROWS = 30;
export const FILED_SHOW_MORE_INCREMENT = 10;
/** The ceiling `limit` may ask for. Above it the answer is a cursor, not a bigger page. */
export const FILED_PAGE_LIMIT_MAX = 1_000;

/**
 * One query value, collapsing a repeated key to its first — the same `queryValue` union
 * `server/server.ts` uses everywhere else, so a duplicated key answers 200 here as it does there
 * rather than newly 400ing.
 */
const oneQueryValue = z
  .union([z.string(), z.array(z.string()).transform((values) => values[0] as string)])
  .optional();

/**
 * A repeatable facet key: `?status=todo&status=blocked`. A single value reads as a one-element
 * list; an absent key stays `undefined` and the reader treats it as none selected (= every value).
 *
 * `.optional()` is the OUTERMOST wrapper on every key in this schema, deliberately. Hono derives
 * a validated route's REQUEST type from `z.input`, and a `.transform()` applied after `.optional()`
 * erases the key's optionality — which made `hc` demand a `status` and a `limit` from every caller,
 * including the legacy no-params one. Normalize the absent case in the reader, never here.
 */
const manyQueryValues = z
  .union([z.string().transform((value) => [value]), z.array(z.string())])
  .optional();

/**
 * `GET /api/v1/workspace/todos` query. **Every key is optional, and a request carrying none of
 * them is the legacy path** — no paging, no ordering, no filtering, and a response with neither
 * `page` nor `counts` (`BACKWARD_COMPATIBILITY.md` §2: additive is fine, making an existing
 * output disappear is not).
 *
 * `limit` is spelled as refinements over the raw string rather than `z.coerce.number()` so each
 * rejection names what is wrong with it ("must be a positive integer" vs. "must be between 1 and
 * 1000") instead of a union's stacked issues.
 */
export const workspaceTodosQuerySchema = z.object({
  partition: oneQueryValue.pipe(filedPartitionSchema.optional()),
  sort: oneQueryValue.pipe(filedSortColumnSchema.optional()),
  dir: oneQueryValue.pipe(filedSortDirSchema.optional()),
  view: oneQueryValue.pipe(filedViewSchema.optional()),
  limit: z
    .union([z.string(), z.array(z.string()).transform((values) => values[0] as string)])
    .refine((value) => /^\d+$/.test(value), { message: 'must be a positive integer' })
    .transform((value) => Number(value))
    .refine((value) => value >= 1 && value <= FILED_PAGE_LIMIT_MAX, {
      message: `must be between 1 and ${FILED_PAGE_LIMIT_MAX}`,
    })
    .optional(),
  q: oneQueryValue.refine((value) => value === undefined || value.length <= 500, {
    message: 'must be at most 500 characters',
  }),
  status: manyQueryValues,
  priority: manyQueryValues,
});
export type WorkspaceTodosQuery = z.infer<typeof workspaceTodosQuerySchema>;
export type WorkspaceTodosQueryInput = z.input<typeof workspaceTodosQuerySchema>;

/**
 * The page envelope, present only when the request named a `partition`.
 *
 * `total` is the matching rows in this partition AFTER filters; `partitionTotal` is the rows in
 * it BEFORE facets and search, which is what the section's "3 of 40" denominator reads. A
 * `cursor` would go here if `n` ever reached five figures; today `O(n log n)` over ~631 rows is
 * microseconds and needs no index.
 */
export const workspaceTodosPageSchema = z.object({
  partition: filedPartitionSchema,
  sort: filedSortColumnSchema,
  dir: filedSortDirSchema,
  limit: z.number().int(),
  /** `todos.length`. */
  returned: z.number().int(),
  total: z.number().int(),
  partitionTotal: z.number().int(),
  hasMore: z.boolean(),
});
export type WorkspaceTodosPage = z.infer<typeof workspaceTodosPageSchema>;

/**
 * Facet counts for the section's one controls row, each computed over the set narrowed by every
 * facet EXCEPT its own — so unticking a value shows how many rows would come back rather than a
 * number that already assumes the tick (the `filedTasksExcludingFacet` discipline, moved server-
 * side because the client can no longer see the rows it is not sent).
 */
export const workspaceTodosCountsSchema = z.object({
  statuses: z.record(z.string(), z.number().int()),
  priorities: z.record(z.string(), z.number().int()),
});
export type WorkspaceTodosCounts = z.infer<typeof workspaceTodosCountsSchema>;

/**
 * The wire payload. `page` and `counts` are present ONLY when the request named a `partition`;
 * without one this is byte-identical to what the route answered before those keys existed
 * (`BACKWARD_COMPATIBILITY.md` §2). Declared last because it names the partition vocabulary
 * above.
 */
export const workspaceTodosResponseSchema = z.object({
  todos: z.array(workspaceTodoEntrySchema),
  /** One entry per considered project — including a dead one, with `ok: false` and a reason. */
  projects: z.array(workspaceProjectHealthSchema),
  page: workspaceTodosPageSchema.optional(),
  counts: workspaceTodosCountsSchema.optional(),
});
export type WorkspaceTodosResponse = z.infer<typeof workspaceTodosResponseSchema>;
