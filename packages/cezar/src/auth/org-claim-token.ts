import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Per-org bootstrap ("claim") codes — the crux of D11 (spec
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, ADDED 2026-08-07, 5b/5c/8 scaffold pass).
 *
 * `./bootstrap-claim.ts`'s `BootstrapClaim` is ONE code per PROCESS
 * (`resolveBootstrapClaim`, module-scope, resolved once from `CEZ_AUTH_BOOTSTRAP_*`) — sound for a
 * single-org deployment, but D11 needs a code PER ORG: a supervisor terminating auth for N orgs
 * (D10) must not let org one's owner also claim org two just because both orgs' first users saw
 * the same deployment-wide secret. Org one's owner already HAS that secret — they used it to
 * claim org one — so leaving it as the only gate would make it a permanent skeleton key across
 * every future org, exactly the property `bootstrap-claim.ts`'s own doc comment relies on being
 * false ("a leaked code afterwards grants nothing").
 *
 * This module is the two-sided contract for the per-org code, written and tested together the way
 * `supervisor/forwarded-principal.ts` was for D10's signed-principal handoff, so the two Fill units
 * that need it converge on one scheme instead of each inventing one:
 *
 *  - **Mint + hash** (Fill unit 6, `POST /internal/orgs`): `mintOrgClaimToken()` draws the raw
 *    code; `hashOrgClaimToken()` is what actually gets stored, on `Org.claimTokenHash`
 *    (`./types.ts`) — via `IdentityStore#createOrg`'s additive `claimTokenHash` input, already
 *    wired in this pass. The raw code is returned ONCE, in that route's HTTP response, for the
 *    installer to print — never persisted anywhere in the clear.
 *  - **Verify** (Fill unit 7, the renamed claim-an-unclaimed-org method):
 *    `matchesOrgClaimToken(org.claimTokenHash, supplied)`.
 *
 * **Hash, never the raw token, at rest — same reasoning `identity-store.ts` already applies to the
 * file as a whole (D7: `identity.json` is 0600, `chmodSync` reasserted post-rename).** A leak of
 * that file (a stray backup, a misconfigured static-file route on some future admin surface) must
 * not also hand out every org's live claim code, the same way a leaked password hash is not a
 * leaked password.
 *
 * **128 bits, hex — the same size `bootstrap-claim.ts`'s `defaultMint` already chose**, for the
 * identical reason: unguessable, and short enough to retype off a terminal without hating it.
 */

const CLAIM_TOKEN_BYTES = 16;

/** Mints a fresh per-org claim code. Never called on the `CEZ_AUTH` off path — there is no
 *  `/internal/orgs` route to mint one for — so, like `bootstrap-claim.ts`'s own `defaultMint`, this
 *  draws real entropy unconditionally rather than guarding an off-path that never reaches it. */
export function mintOrgClaimToken(): string {
  return randomBytes(CLAIM_TOKEN_BYTES).toString('hex');
}

/** SHA-256 hex digest — what actually lands on `Org.claimTokenHash`. Deterministic (same input,
 *  same output), so `IdentityStore#createOrg`'s uniqueness/atomicity story is untouched: this is a
 *  pure derivation of the value the caller already decided to store, not a second source of
 *  randomness the store would have to reason about. */
export function hashOrgClaimToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time. Unlike `bootstrap-claim.ts#matchesBootstrapClaim` — which compares two RAW,
 * caller-supplied-length strings and has to special-case a length mismatch before it can call
 * `timingSafeEqual` (which throws on one) — `hashOrgClaimToken` always returns a fixed 64-hex-char
 * digest, so hashing the supplied value FIRST removes the length-mismatch case entirely rather than
 * merely guarding it. The same "hash both sides, then compare fixed-width digests" shape
 * `supervisor/internal-auth.ts#constantTimeEquals` already uses for the admin/org-secret bearer
 * check.
 */
export function matchesOrgClaimToken(storedHash: string, supplied: string | undefined): boolean {
  if (supplied === undefined) return false;
  const a = Buffer.from(hashOrgClaimToken(supplied), 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false; // defensive only: both are always 64 hex chars
  return timingSafeEqual(a, b);
}
