import { z } from 'zod';
import type { WorkspaceRunDigestProject } from '../workspace/run-index.ts';
import type { NoteProjectEntry } from './coordinator.ts';

/**
 * The triage prompt (P2.2, spec `.ai/specs/2026-08-14-note-to-spec-pipeline.md`).
 *
 * This file is where the two behaviours that make the feature worth having actually live, and
 * both are prompt shape rather than code:
 *
 * 1. **Split.** A note that describes three things becomes three proposals, not one. A single
 *    blob proposal is what you already had before the pass ran; splitting is the work.
 * 2. **Dedupe.** Every considered project's live board is in the prompt, so a proposal that
 *    restates something already running comes back flagged. Without the board in the prompt the
 *    pass produces one new task per note *by construction* — it has nothing to compare against,
 *    so it cannot help but propose everything afresh.
 *
 * The pass proposes and NEVER creates: creation happens on a human click, in
 * `server/notes-routes.ts` → `./approve.ts`. Saying so in the system prompt is belt-and-braces
 * (the pass has no tools and its answer is parsed as data), but a model that believes it is
 * dispatching work writes differently from one that believes it is drafting.
 */

export const NOTE_PASS_TIMEOUT_MS = 120_000;

/** The proposal cap the contract also enforces (`notePassSchema.proposals.max(12)`). Stated in the
 *  prompt as well so the model aims under it, rather than writing twenty and having eight
 *  silently dropped by a parse. */
export const MAX_PROPOSALS = 12;

/** Live runs shown per project. Enough to recognise a duplicate; small enough that twenty-five
 *  projects' boards do not crowd out the note itself. */
export const DIGEST_PER_PROJECT = 12;

export const NOTE_PASS_SYSTEM_PROMPT = [
  'You are the triage pass of a coding-agent cockpit. You read one free-form note and propose the',
  'tasks it implies, each targeted at exactly one project from the supplied catalog.',
  '',
  'Respond with ONLY a JSON object:',
  '{"summary":string,"proposals":[{"projectId":string,"title":string,"task":string,',
  '"rationale":string,"confidence":"high"|"medium"|"low","workflow"?:string,',
  '"duplicateOf"?:{"projectId":string,"runId"?:string,"title":string,"reason":string}}],',
  '"unassigned":[{"text":string,"reason":string}]}',
  '',
  'Rules:',
  `- SPLIT. One proposal per distinct piece of work. A note covering three things is three`,
  `  proposals in up to three projects, never one blob. At most ${MAX_PROPOSALS}.`,
  '- DEDUPE. Each project lists its live runs. If a proposal restates work already on that board,',
  '  still emit it but set "duplicateOf" naming the run and why. Never silently drop it: you are',
  '  advising a human review screen, and a dropped line is a decision you were not asked to make.',
  '- "projectId" MUST be an id from the catalog, copied exactly. If a piece of work belongs to no',
  '  catalogued project, put it in "unassigned" with the reason — never force it into the nearest',
  '  project, and never invent an id.',
  '- "task" is the brief handed to an agent that will investigate inside that repository and write',
  '  a spec. Say what to build and why it matters; do not guess at file paths, APIs or designs you',
  '  have not seen. You are looking at a note and a list of run titles, nothing else.',
  '- "workflow", if given, must be a workflow name listed for THAT project.',
  '- Propose nothing you cannot justify from the note. An empty "proposals" array is a valid',
  '  answer for a note that implies no work.',
  '',
  'You are drafting for review. Nothing you write starts a run; a person approves each row.',
].join('\n');

export const notePassResponseSchema = z.object({
  summary: z.string().default(''),
  proposals: z
    .array(
      z.object({
        projectId: z.string(),
        title: z.string().min(1),
        task: z.string().min(1),
        rationale: z.string().default(''),
        confidence: z.enum(['high', 'medium', 'low']).optional(),
        workflow: z.string().optional(),
        skill: z.string().optional(),
        duplicateOf: z
          .object({
            projectId: z.string(),
            runId: z.string().optional(),
            title: z.string(),
            reason: z.string().default(''),
          })
          .optional(),
      }),
    )
    .default([]),
  unassigned: z
    .array(z.object({ text: z.string(), reason: z.string().default('') }))
    .default([]),
});
export type NotePassResponse = z.infer<typeof notePassResponseSchema>;

export interface NotePassPromptInput {
  note: { title: string; body: string; projectHint?: string };
  catalog: readonly NoteProjectEntry[];
  digest: Record<string, WorkspaceRunDigestProject>;
}

/** The `[cez-note-pass]` marker lets the `CEZ_DRY_RUN` mock recognize a triage call, the same way
 *  `[cez-planner]` does for `planChain`. */
export function buildNotePassPrompt(input: NotePassPromptInput): string {
  const lines: string[] = ['[cez-note-pass] Triage this note into tasks.', '', 'Note:'];
  if (input.note.title) lines.push(`Title: ${input.note.title}`);
  lines.push(input.note.body, '');

  if (input.note.projectHint) {
    // ADVISORY, and said out loud as advisory. A hint that reads as an instruction becomes a
    // default target, and the whole value of the pass is that it decides where work belongs.
    lines.push(
      `The person who wrote this suggested project "${input.note.projectHint}". Treat that as a`,
      'hint only — overrule it if the note says otherwise.',
      '',
    );
  }

  lines.push('Projects (id — name — tags — workflows):');
  if (input.catalog.length === 0) {
    lines.push('(no projects registered — put everything in "unassigned")');
  } else {
    for (const project of input.catalog) {
      const tags = project.tags.length > 0 ? project.tags.join(', ') : 'no tags';
      const workflows = project.workflows.length > 0 ? project.workflows.join(', ') : 'none';
      const flag = project.status === 'not-git' ? ' [not a git repo]' : '';
      lines.push(`- ${project.id} — ${project.name} — ${tags} — workflows: ${workflows}${flag}`);
    }
  }
  lines.push('');

  lines.push('Live board (what is already running or recently ran, per project):');
  let anyBoard = false;
  for (const project of input.catalog) {
    const board = input.digest[project.id];
    if (!board) continue;
    if (!board.ok) {
      // Named rather than omitted: "this project's board could not be read" is information the
      // pass should weigh, and silence would read as "nothing is running there".
      lines.push(`- ${project.id}: board unavailable (${board.reason ?? 'unknown reason'})`);
      anyBoard = true;
      continue;
    }
    if (board.entries.length === 0) {
      lines.push(`- ${project.id}: nothing running`);
      anyBoard = true;
      continue;
    }
    lines.push(`- ${project.id}:`);
    for (const entry of board.entries) {
      lines.push(`  - [${entry.id}] ${entry.title} (${entry.status})`);
    }
    anyBoard = true;
  }
  if (!anyBoard) lines.push('(no boards available)');

  lines.push('', 'Answer with the JSON object only.');
  return lines.join('\n');
}
