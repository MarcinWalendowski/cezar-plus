import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { workspaceConfigPath } from './paths.ts';

/**
 * The `reports` key of `~/.cezar/config.json` — the one routing/vocabulary map behind the
 * workspace Reports tab (`.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`, "Reports is a
 * workspace tab" amendment).
 *
 * **Why the OPERATOR's file and not a repo's own `.ai/cezar/config.json` (CHANGED 2026-08-19).**
 * This block lived in the per-project `configSchema` (`./config.ts`) for one afternoon. It could
 * not stay: reports arrive through a knowledge mount that is itself declared in this same
 * workspace file (`.ai/specs/2026-08-19-tasks-page-and-start-grounding.md` D3), so on the
 * deployment that motivated this, all 12 registered projects resolved the same 196 reports. Twelve
 * repo-local copies of one routing map is twelve places for it to disagree with itself about where
 * one report's work belongs — one tab, one map. The config is where the corpus is declared.
 *
 * Contract copied verbatim from `knowledge/paths.ts`'s `readWorkspaceKnowledgeMountConfig`, and
 * for its stated reasons (Q11): **never cached** (a snapshot of a file two cezar processes share is
 * a staleness bug), **never throws**, and every failure — a missing file, malformed JSON, a
 * `reports` block the schema refuses — degrades to `{}` so the queue stays readable rather than
 * taking the tab down. `workspaceConfigSchema` is `.passthrough()`, so an older cezar sharing this
 * home preserves the key on its next write instead of dropping it.
 */

/** Tolerant zod over the ONE key, ignoring everything else in the file. Every field optional; the
 *  caller (`server/workspace-reports-routes.ts`) owns the defaults, so an absent key and an absent
 *  file are indistinguishable here on purpose — both mean "said nothing". */
export const workspaceReportsConfigSchema = z.object({
  /** Which knowledge tags mark a document as a report. Unset = the family's own default set. */
  tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  /**
   * Which knowledge tags mean the report was ALREADY handled, by whatever tracker filed it, before
   * triage existed here. Such a report opens as `approved` with no triage row and is never
   * auto-converted. Unset = the family's default (`status/processed`); an explicit `[]` turns the
   * behaviour off and puts every report back in the pending queue.
   */
  handledTags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  /**
   * Permit `POST /workspace/reports/process-pending` to convert every pending report into a todo
   * without a human deciding each one. Absent reads as OFF — auto-conversion has to be asked for,
   * so a corpus nobody has configured can never be mass-converted by a stray call.
   */
  auto: z.boolean().optional(),
  /**
   * Report `domain` → the project id whose todo inbox that report's work belongs in. A report's
   * `domain` is a PRODUCT axis (`beside`, `predicts`) while a todo inbox is a REPO, and only this
   * deployment knows the mapping. An unmapped domain mints into the row's CANONICAL project (the
   * first that resolves the document), which is always a valid target.
   *
   * This map is the cross-project answer the original per-project design claimed did not exist —
   * "a cross-project report queue would need a cross-project answer for where an approval files its
   * task". It does, and this is it: a product axis resolved at the scope where products are known.
   */
  routeByDomain: z.record(z.string(), z.string().trim().min(1).max(200)).optional(),
});
export type WorkspaceReportsConfig = z.infer<typeof workspaceReportsConfigSchema>;

export async function readWorkspaceReportsConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceReportsConfig> {
  let raw: string;
  try {
    raw = await readFile(workspaceConfigPath(env), 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const reports = (parsed as Record<string, unknown>).reports;
    const result = workspaceReportsConfigSchema.safeParse(reports ?? {});
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}
