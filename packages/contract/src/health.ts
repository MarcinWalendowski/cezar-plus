import { z } from 'zod';

/** The agent backends a run can be dispatched to. */
export const runnerSchema = z.enum(['claude', 'codex', 'opencode', 'pi']);
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
  name: z.enum(['claude', 'codex', 'opencode', 'pi', 'gh', 'git']),
  available: z.boolean(),
  version: z.string().optional(),
  hint: z.string().optional(),
});
export type BackendCheck = z.infer<typeof backendCheckSchema>;

/**
 * `CEZ_AUTH` (D1, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`): which auth provider,
 * if any, this deployment requires. `'none'` is the default — an unset env, or any spelling other
 * than the two exact provider names, resolves to it (`resolveAuthProvider` in
 * `server/capabilities.ts`), the same "unrecognised means off" discipline `skills`/`singleProject`
 * already use for their own flags.
 *
 * **Deliberately NOT a member of `capabilitiesSchema` below**, unlike every other flag derived
 * from a `CEZ_*` variable. Two reasons, and the first is the binding one:
 *
 *  - The spec's Risks section makes the auth-off health payload the *control* for this whole
 *    change — "a diff in the auth-off health payload is a failure, not an update" — with
 *    route-parity / bc-route-inventory / versioned-surface as the suites that hold it. Adding a
 *    key and then editing ~20 fixture files to expect it is updating the control to match the
 *    change, which is the one move that makes a control stop meaning anything. It was written
 *    that way first and reverted here.
 *  - Nothing consumes it. Every other capability gates a cockpit surface; `auth` gates nothing in
 *    the client, because an unauthenticated cockpit gets a 401 from `requirePrincipal` and learns
 *    what it needs from that. Whichever phase builds a login screen is the right place to decide
 *    what the client is told and to add the key deliberately, with a BACKWARD_COMPATIBILITY §2
 *    entry beside the `tokenUsageMetrics`/`costMetrics` one.
 *
 * The type stays here because the contract package is where shared wire-adjacent types live, and
 * `server/capabilities.ts`, `auth/session.ts` and `auth/oidc.ts` all name it.
 *
 * **`'supervisor'` added 2026-08-07 (D10, phase 6/7 fill unit 5 — "root-org-registry").** Not a
 * third way to LOG IN — `oidc`/`google` are the only providers that ever terminate real
 * authentication (D9). `'supervisor'` names the phase-6+ org process: it runs behind a supervisor
 * that already resolved and HMAC-signed the caller's `Principal`
 * (`supervisor/forwarded-principal.ts`), so `CEZ_AUTH=supervisor` tells this process to trust that
 * forwarded, verified signature rather than terminate OIDC/Google itself or open a local identity
 * store (this process's `CEZ_HOME` holds no `identity/` directory under D4). It still satisfies
 * every existing "`CEZ_AUTH` names a provider" check the same way `oidc`/`google` do —
 * `auth-boot-gate.ts`'s whole decision is `provider !== 'none'` ⇒ proceed, so it needed no change —
 * and it is deliberately excluded from `OidcProvider` (`auth/oidc.ts`), which stays `oidc | google`
 * exactly, since this process never runs the OIDC/PKCE flow.
 */
export const authProviderSchema = z.enum(['none', 'oidc', 'google', 'supervisor']);
export type AuthProvider = z.infer<typeof authProviderSchema>;

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
   * `true` means `CEZ_AUTOMATIONS=1` opted this server into GitHub automations (#801). Off — the
   * default — the whole feature is absent: no `Automations` nav item anywhere it is rendered, the
   * `/api/v1/…/automations*` family answers `409`, and the workspace scheduler never polls GitHub.
   *
   * REQUIRED for the same reason as `tokenMetrics` below: this server always sends it.
   */
  automations: z.boolean(),
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
  /**
   * `CEZ_ACCOUNT_USAGE=1` (`.ai/specs/2026-08-16-agent-account-usage-routing.md`) — the sidebar
   * panel showing what each agent account is doing and how close it is to its limit.
   *
   * Also `false` in HOSTED mode regardless of the flag, and that is not symmetry for its own sake:
   * the panel names the logged-in account's email, org and plan per login. The rest of the
   * agent-profiles family is already withheld when `localHandoff` is false because it echoes host
   * paths — this discloses who the operator is, which is strictly more than a path.
   */
  accountUsage: z.boolean(),
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
