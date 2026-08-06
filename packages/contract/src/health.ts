import { z } from 'zod';

/** The three agent backends a run can be dispatched to. */
export const runnerSchema = z.enum(['claude', 'codex', 'opencode']);
export type Runner = z.infer<typeof runnerSchema>;

/** Git facts about the project root, or `null` when it is not a repository. */
export const repoInfoSchema = z.object({
  root: z.string(),
  branch: z.string(),
  remote: z.string().optional(),
});
export type RepoInfo = z.infer<typeof repoInfoSchema>;

/** One probed CLI behind the Tools menu. */
export const backendCheckSchema = z.object({
  name: z.enum(['claude', 'codex', 'opencode', 'gh', 'git']),
  available: z.boolean(),
  version: z.string().optional(),
  hint: z.string().optional(),
});
export type BackendCheck = z.infer<typeof backendCheckSchema>;

export const forgeInfoSchema = z.object({
  kind: z.literal('github'),
  /**
   * Whether the forge is reachable — **absent until the availability probe has warmed**.
   *
   * Health must never pay a `gh` shell-out, so it serves whatever the cache holds. Absent means
   * "not determined yet", which is not the same as `false`, and the cockpit renders the two
   * differently. Declaring it required is what made an earlier hand-written mirror wrong.
   */
  available: z.boolean().optional(),
  reason: z.string().optional(),
});
export type ForgeInfo = z.infer<typeof forgeInfoSchema>;

/** Server-side feature switches the cockpit reads once at boot. */
export const capabilitiesSchema = z.object({
  localHandoff: z.boolean(),
  followups: z.boolean(),
  singleProject: z.boolean(),
  /**
   * `false` means `CEZ_HIDE_TOKEN_METRICS=1` asks the browser to omit token counts and monetary
   * cost (#481). The telemetry itself still rides in run/event payloads — this is presentation
   * only.
   *
   * REQUIRED, because this server always sends it (`capabilities.ts` computes it from the env on
   * every read) and this contract describes THIS server's wire. The DTO it replaces declared it
   * optional so a newer cockpit could read an OLDER server, which is version skew a contract
   * versioned in lockstep with the server cannot model. That tolerance lives where it belongs, in
   * `web/src/lib/token-metrics.ts`, whose `!== false` read still treats an absent field as
   * visible.
   */
  tokenMetrics: z.boolean(),
  /** Current token-count presentation policy. Required on current servers;
   * older payload tolerance belongs in the browser resolver. */
  tokenUsageMetrics: z.boolean(),
  /** Current backend-reported-cost presentation policy. */
  costMetrics: z.boolean(),
  /** `CEZ_KB=1` (F1, knowledge base). Exact-`'1'` gate; every other spelling stays off. */
  knowledge: z.boolean(),
  /** `CEZ_SOURCES=1` (F2, external source connectors / Notion mirror). */
  sources: z.boolean(),
  /** `CEZ_NOTES=1` (F3, the workspace capture inbox). */
  notes: z.boolean(),
  /** `CEZ_WORKSPACE_VIEWS=1` (F3, the cross-project runs aggregate). Also `false` under
   *  `CEZ_SINGLE_PROJECT=1`, which takes the identical flag-off shape. */
  workspaceViews: z.boolean(),
  /** `CEZ_NOTIFY=1` (F4, outbound notification transports). */
  notify: z.boolean(),
  /** The Skills surface. **Opt-OUT, and the only capability here that is** — `CEZ_SKILLS=0`
   *  hides it; every other value, including unset, leaves it on. Inverted deliberately: every
   *  flag above gates a feature that did not exist before it, so absent-means-off is the honest
   *  default. Skills has shipped since long before this key, so absent must keep meaning ON or
   *  adding the key would silently remove a surface from every existing install. Deployments
   *  that do not use Skills can now hide it without patching the nav table. */
  skills: z.boolean(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

/**
 * `GET /api/v1/health` — the CORS-open discovery endpoint (BACKWARD_COMPATIBILITY.md §2).
 *
 * Additive fields only: this is the most externally-depended-on JSON in the app.
 */
export const healthResponseSchema = z.object({
  version: z.string(),
  latestVersion: z.string().optional(),
  repoRoot: z.string(),
  repo: repoInfoSchema.nullable(),
  checks: z.array(backendCheckSchema),
  defaultRunner: runnerSchema,
  forge: forgeInfoSchema.nullable(),
  capabilities: capabilitiesSchema,
  // Always sent: `workspaceSummary()` returns both unconditionally, and an unreadable workspace
  // degrades to `projects: []` rather than to an absent key. The hand-written DTO declared them
  // optional, which was wider than the server has ever been.
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  bootProject: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
