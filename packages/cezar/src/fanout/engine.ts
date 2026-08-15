import { z } from 'zod';
import { parseStructured } from '../planner.ts';
import type { NoteCoordinator, NoteProjectEntry } from '../notes/coordinator.ts';
import type { WorkspaceRunIndex } from '../workspace/run-index.ts';
import type {
  WorkspaceKnowledgeResultRow,
  WorkspaceKnowledgeSearchOptions,
  WorkspaceKnowledgeSearchResult,
} from '../workspace/knowledge-index.ts';
import {
  DIGEST_PER_PROJECT,
  MAX_ITEM_TITLE_LENGTH,
  MAX_KNOWLEDGE_HITS_PER_ITEM,
  MAX_KNOWLEDGE_QUERY_LENGTH,
  MAX_UNASSIGNED_REASON_LENGTH,
  MAX_WORK_ITEMS,
  PHASE_A_SYSTEM_PROMPT,
  PHASE_B_SYSTEM_PROMPT,
  TODO_ACCEPTANCE_CRITERIA_MAX,
  TODO_ACCEPTANCE_CRITERION_MAX,
  TODO_CONTEXT_MAX,
  TODO_KNOWLEDGE_REFS_MAX,
  TODO_KNOWLEDGE_REF_PROJECT_MAX,
  TODO_KNOWLEDGE_REF_SLUG_MAX,
  TODO_KNOWLEDGE_REF_TITLE_MAX,
  TODO_WHAT_TO_DO_MAX,
  buildPhaseAPrompt,
  buildPhaseBPrompt,
  phaseAResponseSchema,
  phaseBResponseSchema,
  type PhaseAResponse,
} from './prompt.ts';

/**
 * `runTaskFanout` — the analysis engine behind knowledge-grounded task fan-out (D3,
 * `.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`).
 *
 * One request in; N fully-specified work items out, each aimed at one project and grounded in
 * that project's own knowledge base. Two model calls per item plus one shared routing call —
 * **Phase A** (below, once) splits the request and assigns each piece of work to a project;
 * **Phase B** (`specifyItem`, once per item, in parallel) retrieves that project's knowledge and
 * writes the item's Context / What to do / Acceptance criteria grounded in it.
 *
 * **A pure seam, unlike `notes/processor.ts`.** That module is store-bound: it reads `NoteStore`
 * and writes a `StoredNote` back onto it, so testing its logic means also standing up a note
 * store. This module writes nothing — `NoteCoordinator`/`WorkspaceRunIndex`/knowledge search/the
 * model call all arrive as `TaskFanoutDeps`, so the whole engine runs against fakes with no disk
 * I/O and no server. Nothing here imports `NoteStore`, and nothing here touches `.ai/cezar/`.
 *
 * **Nothing runs, nothing is written (D5).** This function only returns data. The caller (a
 * route, out of this module's scope) decides whether/how to persist `items` as todos; no run is
 * ever started here, and no todo is ever written here.
 */

// ---- input / output ------------------------------------------------------------------------

export interface TaskFanoutInput {
  text: string;
  /** `'auto'` (default): the routing pass picks freely from every considered project.
   *  `'all'`: every considered project gets exactly one item, no routing call spent deciding
   *  that (D3's own wording: "every catalogued project gets an item").
   *  `string[]`: restricts the routing pass's candidate set to these registered ids. */
  targets?: 'auto' | 'all' | readonly string[];
}

export interface TaskFanoutKnowledgeRef {
  project: string;
  slug: string;
  title: string;
}

export interface TaskFanoutItem {
  projectId: string;
  projectName: string;
  title: string;
  context: string;
  whatToDo: string;
  acceptanceCriteria: string[];
  /** What grounded this item — empty when nothing was retrieved or nothing was relevant, never
   *  omitted and never invented (D4, Risks: "must be visible in the UI, not silently absent"). */
  knowledgeRefs: TaskFanoutKnowledgeRef[];
}

export interface TaskFanoutUnassigned {
  title: string;
  reason: string;
}

export interface TaskFanoutResult {
  items: TaskFanoutItem[];
  unassigned: TaskFanoutUnassigned[];
  /** Set when Phase A produced more items than `MAX_WORK_ITEMS` and the excess was dropped — a
   *  silent cap reads as "covered everything" (spec Risks), so this must be checked. */
  truncated: boolean;
}

/** One model call, used for both phases: Phase A once, Phase B once per item (in parallel).
 *  Injected so this whole engine runs with no live model — production wires this to the
 *  configured runner (`createRunner`/`resolveProfileEnvForRoot`, the `notes/processor.ts`
 *  pattern), which is the caller's concern, not this module's. */
export type FanoutAsk = (prompt: { systemPrompt: string; userPrompt: string }) => Promise<string>;

export interface TaskFanoutDeps {
  /** Phase A's project catalog — reused from the note pass (D3: "This is the existing pass's
   *  job and its existing inputs; it is reused, not rewritten"), never rebuilt here. A real
   *  `NoteCoordinator` satisfies this narrowed view; tests need not construct a whole notes
   *  pipeline. */
  coordinator: Pick<NoteCoordinator, 'considered' | 'catalog'>;
  /** Phase A's live-board digest — reused from `WorkspaceRunIndex`, same reason. */
  runIndex: Pick<WorkspaceRunIndex, 'digest'>;
  /** Phase B's retrieval. Production wires `WorkspaceKnowledgeIndex.search` bound to the live
   *  instance, called once per item with `{projects: [item.projectId], limit:
   *  MAX_KNOWLEDGE_HITS_PER_ITEM}` — matching D3's own call shape. */
  knowledgeSearch: (
    query: string,
    options: WorkspaceKnowledgeSearchOptions,
  ) => Promise<WorkspaceKnowledgeSearchResult>;
  ask: FanoutAsk;
  now?: () => Date;
  warn?: (message: string) => void;
}

// ---- the engine ---------------------------------------------------------------------------

export async function runTaskFanout(
  input: TaskFanoutInput,
  deps: TaskFanoutDeps,
): Promise<TaskFanoutResult> {
  const targets = input.targets ?? 'auto';
  const text = input.text;

  const projects = await deps.coordinator.considered();
  const fullCatalog = await deps.coordinator.catalog(projects);
  const candidateCatalog = Array.isArray(targets)
    ? fullCatalog.filter((project) => targets.includes(project.id))
    : fullCatalog;

  if (candidateCatalog.length === 0) {
    return {
      items: [],
      unassigned: [
        {
          title: fallbackTitle(text),
          reason:
            fullCatalog.length === 0
              ? 'no projects are registered in this workspace'
              : 'none of the requested projects are registered',
        },
      ],
      truncated: false,
    };
  }

  const routed =
    targets === 'all'
      ? routeAll(text, candidateCatalog)
      : await routePhaseA(text, candidateCatalog, deps);

  const byId = new Map(candidateCatalog.map((project) => [project.id, project] as const));
  const items = await Promise.all(
    routed.items.map((item) => specifyItem(text, item, byId.get(item.projectId)!, deps)),
  );

  return { items, unassigned: routed.unassigned, truncated: routed.truncated };
}

// ---- Phase A -------------------------------------------------------------------------------

interface RoutedItem {
  title: string;
  projectId: string;
}

interface RoutingResult {
  items: RoutedItem[];
  unassigned: TaskFanoutUnassigned[];
  truncated: boolean;
}

/** `targets: 'all'` — deterministic, no model call: every considered project gets exactly one
 *  item, titled from the request itself. `candidateCatalog` is already bounded by
 *  `MAX_CONSIDERED_PROJECTS` (== `MAX_WORK_ITEMS`), so `truncated` is computed rather than
 *  assumed false, in case that invariant ever changes. */
function routeAll(text: string, candidateCatalog: readonly NoteProjectEntry[]): RoutingResult {
  const truncated = candidateCatalog.length > MAX_WORK_ITEMS;
  const items = candidateCatalog
    .slice(0, MAX_WORK_ITEMS)
    .map((project) => ({ title: fallbackTitle(text), projectId: project.id }));
  return { items, unassigned: [], truncated };
}

async function routePhaseA(
  text: string,
  candidateCatalog: readonly NoteProjectEntry[],
  deps: TaskFanoutDeps,
): Promise<RoutingResult> {
  const digest = await deps.runIndex.digest(
    candidateCatalog.map((project) => project.id),
    DIGEST_PER_PROJECT,
  );
  const prompt = buildPhaseAPrompt({ text, catalog: candidateCatalog, digest });
  const answer = await askStructured(
    deps.ask,
    { systemPrompt: PHASE_A_SYSTEM_PROMPT, userPrompt: prompt },
    phaseAResponseSchema,
  );

  if (!answer) {
    deps.warn?.('Task fan-out: the routing pass was unavailable; nothing was assigned.');
    return {
      items: [],
      unassigned: [
        { title: fallbackTitle(text), reason: 'analysis unavailable — the routing pass did not answer' },
      ],
      truncated: false,
    };
  }

  const truncated = answer.items.length > MAX_WORK_ITEMS;
  const kept = { ...answer, items: answer.items.slice(0, MAX_WORK_ITEMS) };
  const sanitized = sanitizePhaseA(kept, candidateCatalog);
  return { ...sanitized, truncated };
}

/**
 * The rule throughout, matching `notes/processor.ts`'s `sanitizeProposals`: **flag, never
 * coerce.** A project id the model invented lands in `unassigned` with a reason — never
 * retargeted at the nearest plausible project, which would be starting work in a project nobody
 * chose.
 */
function sanitizePhaseA(
  answer: PhaseAResponse,
  candidateCatalog: readonly NoteProjectEntry[],
): { items: RoutedItem[]; unassigned: TaskFanoutUnassigned[] } {
  const knownIds = new Set(candidateCatalog.map((project) => project.id));
  const items: RoutedItem[] = [];
  const unassigned: TaskFanoutUnassigned[] = answer.unassigned.map((row) => ({
    title: row.title.slice(0, MAX_ITEM_TITLE_LENGTH),
    reason: (row.reason || 'not assigned to any project').slice(0, MAX_UNASSIGNED_REASON_LENGTH),
  }));

  for (const row of answer.items) {
    const title = row.title.slice(0, MAX_ITEM_TITLE_LENGTH);
    if (!knownIds.has(row.projectId)) {
      unassigned.push({
        title,
        reason: `the routing pass named an unknown project "${row.projectId}"`.slice(
          0,
          MAX_UNASSIGNED_REASON_LENGTH,
        ),
      });
      continue;
    }
    items.push({ title, projectId: row.projectId });
  }

  return { items, unassigned };
}

// ---- Phase B -------------------------------------------------------------------------------

async function specifyItem(
  text: string,
  item: RoutedItem,
  project: NoteProjectEntry,
  deps: TaskFanoutDeps,
): Promise<TaskFanoutItem> {
  let hits: readonly WorkspaceKnowledgeResultRow[] = [];
  try {
    const query = `${item.title}\n\n${text}`.slice(0, MAX_KNOWLEDGE_QUERY_LENGTH);
    const result = await deps.knowledgeSearch(query, {
      projects: [item.projectId],
      limit: MAX_KNOWLEDGE_HITS_PER_ITEM,
    });
    hits = result.results;
  } catch (error) {
    deps.warn?.(`Task fan-out: knowledge search failed for ${item.projectId}: ${describeError(error)}`);
  }

  const prompt = buildPhaseBPrompt({
    text,
    item: { title: item.title, projectId: item.projectId, projectName: project.name },
    hits,
  });
  const answer = await askStructured(
    deps.ask,
    { systemPrompt: PHASE_B_SYSTEM_PROMPT, userPrompt: prompt },
    phaseBResponseSchema,
  );

  if (!answer) {
    deps.warn?.(
      `Task fan-out: the specification pass was unavailable for "${item.title}" (${item.projectId}).`,
    );
    // An item with nowhere to write its spec still produces a task (D3/D5) — an honest, minimal
    // one, not a dropped one: the request itself becomes the work-to-do, same degradation
    // `notes/processor.ts`'s `degraded()` uses for a failed pass.
    return {
      projectId: item.projectId,
      projectName: project.name,
      title: item.title,
      context: '',
      whatToDo: text.slice(0, TODO_WHAT_TO_DO_MAX),
      acceptanceCriteria: [],
      knowledgeRefs: [],
    };
  }

  return {
    projectId: item.projectId,
    projectName: project.name,
    title: item.title,
    context: answer.context.slice(0, TODO_CONTEXT_MAX),
    whatToDo: answer.whatToDo.slice(0, TODO_WHAT_TO_DO_MAX),
    acceptanceCriteria: answer.acceptanceCriteria
      .slice(0, TODO_ACCEPTANCE_CRITERIA_MAX)
      .map((criterion) => criterion.slice(0, TODO_ACCEPTANCE_CRITERION_MAX)),
    knowledgeRefs: sanitizeCitations(answer.citations, hits),
  };
}

/** Every citation must name a hit that was ACTUALLY retrieved for this item — an invented slug,
 *  or one belonging to another project's hit list, is dropped rather than trusted (D4: "never
 *  invent citations"). Deduped by slug and capped at the contract's own `knowledgeRefs` limit. */
function sanitizeCitations(
  citations: readonly string[],
  hits: readonly WorkspaceKnowledgeResultRow[],
): TaskFanoutKnowledgeRef[] {
  const bySlug = new Map(hits.map((hit) => [hit.document.slug, hit] as const));
  const seen = new Set<string>();
  const refs: TaskFanoutKnowledgeRef[] = [];

  for (const slug of citations) {
    if (refs.length >= TODO_KNOWLEDGE_REFS_MAX) break;
    if (seen.has(slug)) continue;
    const hit = bySlug.get(slug);
    if (!hit) continue;
    seen.add(slug);
    refs.push({
      project: hit.project.slice(0, TODO_KNOWLEDGE_REF_PROJECT_MAX),
      slug: hit.document.slug.slice(0, TODO_KNOWLEDGE_REF_SLUG_MAX),
      title: hit.document.title.slice(0, TODO_KNOWLEDGE_REF_TITLE_MAX),
    });
  }

  return refs;
}

// ---- shared helpers -------------------------------------------------------------------------

/** One model call, one retry on an unparseable answer, then give up — `planChain`'s and
 *  `NoteProcessor.ask`'s discipline exactly. A runner error does NOT retry: it is not a
 *  condition a second identical call improves. */
async function askStructured<T>(
  ask: FanoutAsk,
  prompt: { systemPrompt: string; userPrompt: string },
  schema: z.ZodType<T, unknown>,
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = await ask(prompt);
    } catch {
      return null;
    }
    const parsed = parseStructured(text, schema);
    if (parsed) return parsed;
  }
  return null;
}

/** The request's first non-empty line, capped like any other title — used for `targets: 'all'`
 *  items (no model call decides their title) and for the top-level degraded-analysis cases. */
function fallbackTitle(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0)?.trim();
  return (firstLine || text.trim() || 'Untitled task').slice(0, MAX_ITEM_TITLE_LENGTH);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
