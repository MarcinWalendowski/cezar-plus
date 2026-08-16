import { z } from 'zod';
import { providerIdSchema } from './workspace.ts';

/**
 * Per-account usage — what the sidebar panel renders
 * (`.ai/specs/2026-08-16-agent-account-usage-routing.md`, `CEZ_ACCOUNT_USAGE=1`).
 *
 * ## The shape carries the honesty rule, so a client cannot break it by accident
 *
 * There is no `usedPercent` on the row. There is an OPTIONAL `quota` object, and it is present
 * only for an account whose provider actually reported one — which today means Codex and only
 * Codex. `claude auth status --json` answers `{loggedIn, authMethod, email, orgId, orgName,
 * subscriptionType}`: identity and a plan NAME, no quantity anywhere, and there is no other
 * subcommand and nothing on disk to read.
 *
 * Modelling it as `quota?: {...}` rather than `usedPercent: number` is what makes the absence
 * impossible to render as a zero. A required number would have forced every Claude row to carry
 * one, and the only numbers available are spend — which is not allowance, and would have been
 * drawn as a bar beside the Codex bar that means something else. Two rows that look alike must
 * mean alike.
 *
 * `enabled` exists so a client can tell "the flag is off" from "you have no accounts". Both answer
 * `accounts: []`, and the empty states read completely differently to a user.
 */

/** One rate-limit window exactly as the provider stated it. `resetsAt` is UNIX **seconds**. */
export const accountQuotaWindowSchema = z.object({
  /** May exceed 100 — a provider is allowed to report an overage, and clamping would hide it. */
  usedPercent: z.number(),
  /** Window length, so the UI can say "5h" / "week" rather than inventing a label per provider. */
  windowMinutes: z.number().int().positive(),
  resetsAt: z.number().int().nonnegative(),
});
export type AccountQuotaWindow = z.infer<typeof accountQuotaWindowSchema>;

/** A quota snapshot. Present ONLY where the provider reports allowance — see the module note. */
export const accountQuotaSchema = z.object({
  /** When cezar asked. The client drops a snapshot that is too old rather than dimming it: an
   *  absent bar is honest, an old bar still reads as "this is my usage right now". */
  takenAt: z.string(),
  /** The provider's own plan name (`pro`, `free`, …) when it stated one. */
  planType: z.string().optional(),
  windows: z.array(accountQuotaWindowSchema),
});
export type AccountQuota = z.infer<typeof accountQuotaSchema>;

export const accountUsageRowSchema = z.object({
  /** `agentAccountRouteId()`'s encoding — `default:<provider>` or the stored slug. */
  id: z.string(),
  provider: providerIdSchema,
  label: z.string(),
  isDefault: z.boolean(),

  /** Live runs on this account right now. Counted from the running stores, never persisted — a
   *  stored counter leaks a phantom run on every crash and the account looks busy forever. */
  inflight: z.number().int().nonnegative(),

  /**
   * Whether the CLI says this account is signed in.
   *
   * Tri-state ON PURPOSE. `true`/`false` are answers the CLI gave; **absent means cezar could not
   * ask** — not installed, timed out, unparseable. "Signed out" is worth showing on a row and
   * "could not ask" is not, and collapsing them would put a red state on a working account.
   */
  signedIn: z.boolean().optional(),
  /** Plan NAME, never a quantity (`max`, `pro`, `free`). */
  plan: z.string().optional(),
  email: z.string().optional(),

  /** True while this account is inside an observed limit window. */
  limited: z.boolean(),
  /** When it recovers, ONLY when that was stated or bounded — never a guessed time. */
  limitedUntil: z.string().optional(),

  /** Absent for every provider that does not report allowance. That is the point. */
  quota: accountQuotaSchema.optional(),
});
export type AccountUsageRow = z.infer<typeof accountUsageRowSchema>;

/** `GET /api/v1/workspace/agent-accounts/usage`. Flag-off answers 200 with `enabled: false` and an
 *  empty list — the `notes` family's shape, so a 404 keeps meaning "no such route". */
export const accountUsageResponseSchema = z.object({
  enabled: z.boolean(),
  accounts: z.array(accountUsageRowSchema),
});
export type AccountUsageResponse = z.infer<typeof accountUsageResponseSchema>;
