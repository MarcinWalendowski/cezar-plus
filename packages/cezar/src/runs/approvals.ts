/**
 * How many humans must approve a gated step before the chain moves on
 * (`.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`, P3).
 *
 * **Zero is the shipped default, and zero means AUTO-APPROVED** — owner decision 2026-08-20
 * ("settings: eg. min 1, but by default it should be 'auto approved'"). At 0 a step carrying
 * `requiresApproval` never parks and the engine takes the same path it took before the flag
 * existed, so no existing run changes behaviour. AGENTS.md § "A replacement that ships OFF is
 * not a replacement" applies and is answered elsewhere: the safety value of the review step at
 * the default rests on the agent's own `CEZ:REVIEW` verdict, not on this gate.
 *
 * Precedence mirrors `reviewGateEnabled` exactly (`runs/review-gate.ts`): the `config.approvals`
 * Settings value wins when set, otherwise `CEZ_MIN_APPROVERS` decides, otherwise 0.
 *
 * `CEZ_MIN_APPROVERS` is parsed strictly — a non-integer, a negative, or anything above the cap
 * degrades to 0 rather than throwing or clamping silently upward. A malformed env must never
 * turn a gate ON that the operator did not ask for; failing OPEN is the safe direction here,
 * because failing closed would park every run on the box behind an approval nobody knew to give.
 */
export const MAX_APPROVERS = 10;

export function minApprovers(
  config: { approvals?: { minApprovers?: number } },
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = config.approvals?.minApprovers;
  if (configured !== undefined) return configured;
  const raw = env.CEZ_MIN_APPROVERS;
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_APPROVERS) return 0;
  return parsed;
}

/**
 * Is this run's gate satisfied? Counts DISTINCT `by` values, not clicks.
 *
 * The honest limitation, stated here rather than discovered later: on a single-user local
 * install every approval carries the same identity, so a `minApprovers` above 1 can never be
 * satisfied by one person clicking twice — which is the correct behaviour for a setting whose
 * name says "approvers", and the reason `POST /runs/:id/approve` reports how many DISTINCT
 * approvers it has rather than a click count. An operator who wants "two clicks" does not want
 * this setting.
 */
export function approvalsSatisfied(
  approvals: readonly { by: string }[],
  required: number,
): boolean {
  if (required <= 0) return true;
  return new Set(approvals.map((a) => a.by)).size >= required;
}
