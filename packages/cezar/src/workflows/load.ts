import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  NOTE_TO_SPEC_WORKFLOW,
  QUICK_TASK_WORKFLOW,
  SPEC_TO_DEPLOY_CODEX_NAME,
  SPEC_TO_DEPLOY_WORKFLOW,
  normalizeWorkflowDoc,
  pinWorkflowRunner,
  stepsIssue,
  workflowFileSchema,
  type WorkflowDef,
} from './types.ts';

export const WORKFLOWS_DIR = '.ai/cezar/workflows';

export interface WorkflowLoadIssue {
  path: string;
  message: string;
}

/**
 * Load the workflow catalog: the built-ins (`quick-task`, `note-to-spec`,
 * `spec-to-deploy`) plus every `.ai/cezar/workflows/*.{yaml,yml}` in the repo.
 * File workflows win name collisions with built-ins. Invalid files are
 * reported, never fatal.
 */
export async function loadWorkflows(
  repoRoot: string,
): Promise<{ workflows: WorkflowDef[]; issues: WorkflowLoadIssue[] }> {
  const dir = resolve(repoRoot, WORKFLOWS_DIR);
  const issues: WorkflowLoadIssue[] = [];
  const fromFiles: WorkflowDef[] = [];

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    // no workflows dir — built-ins only
  }

  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml') continue;
    const path = join(dir, entry);
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = workflowFileSchema.safeParse(parseYaml(raw));
      if (!parsed.success) {
        issues.push({ path, message: parsed.error.issues.map((i) => i.message).join('; ') });
        continue;
      }
      // `skills:` shorthand files become plain agent steps here (spec 012).
      const normalized = normalizeWorkflowDoc(parsed.data);
      // Steps referenced by onFail.retry must exist and come earlier; ids unique.
      const issue = stepsIssue(normalized.steps);
      if (issue) {
        issues.push({ path, message: issue });
        continue;
      }
      fromFiles.push({ ...normalized, source: 'file', path });
    } catch (err) {
      issues.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const fileNames = new Set(fromFiles.map((w) => w.name));
  const builtins = [QUICK_TASK_WORKFLOW, NOTE_TO_SPEC_WORKFLOW, SPEC_TO_DEPLOY_WORKFLOW].filter(
    // A repo may override any built-in by shipping a file of the same name — same rule for all,
    // so `note-to-spec`/`spec-to-deploy` are customisable per project without any new mechanism.
    (w) => !fileNames.has(w.name),
  );
  const workflows = [...fromFiles, ...builtins];

  // The codex-pinned sibling of `spec-to-deploy` (`.ai/specs/2026-08-24-codex-only-default-
  // workflow.md`, D4): derived AFTER file-override resolution, off whichever `spec-to-deploy`
  // won above, so a repo that customises `spec-to-deploy.yaml` gets a codex sibling of ITS OWN
  // chain rather than of the built-in it replaced. Skipped entirely when a repo ships its own
  // `spec-to-deploy-codex.yaml` — that file wins by name, same rule as every other built-in.
  if (!fileNames.has(SPEC_TO_DEPLOY_CODEX_NAME)) {
    const base = workflows.find((w) => w.name === SPEC_TO_DEPLOY_WORKFLOW.name);
    if (base) {
      const derived = pinWorkflowRunner(base, 'codex', {
        name: SPEC_TO_DEPLOY_CODEX_NAME,
        description:
          'The default chain with every agent step pinned to codex; falls back when every codex account is quota-limited.',
      });
      // Metadata is NOT inherited (D4): a generated workflow always reports itself as one, even
      // when `base` was resolved from a file. `{ ...base }` alone would leak the base's own
      // `source: 'file'` and `path`, presenting this generated sibling as that YAML file.
      workflows.push({ ...derived, source: 'built-in', path: undefined });
    }
  }

  workflows.sort((a, b) => a.name.localeCompare(b.name));
  return { workflows, issues };
}
