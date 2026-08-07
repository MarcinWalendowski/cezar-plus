import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveAuthProvider } from '../server/capabilities.ts';

/**
 * **Who is allowed to be the first user** (spec
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, D8 step 1, ADDED 2026-08-07 at the repair
 * stage).
 *
 * D8 step 1 says "the first user to sign in becomes owner of a new org; subsequent users need an
 * invite." It never says *who is allowed to be first*, and phase 4 shipped the literal reading:
 * the only gate between an ID token the IdP verified and `role: 'owner'` was arriving first.
 * `oidc.ts#resolveOidcConfig` has no `hd`, no email-domain allowlist and no subject list, so with
 * `CEZ_AUTH=google` the issuer is *pinned to Google* and the eligible set is every Google account
 * on the internet. Reproduced end to end at review: `GET /api/v1/runs` → 401, one
 * `POST /auth/onboarding/org` by a stranger's session → 201 `role: "owner"`, then
 * `POST /api/v1/workflows` → 201 with a free-form `command:` that a check step runs as
 * `spawn('bash', ['-lc', command], { env: process.env })` — the spec's own Problem §3.
 *
 * The exposure window is real and unattended: an operator sets `CEZ_AUTH=google` +
 * `CEZ_PUBLIC_URL=https://cezar.acme.com`, starts the unit, and the hostname is public the moment
 * the TLS certificate hits Certificate Transparency.
 *
 * **The fix is D1's own doctrine applied one layer in.** D1 refuses to boot a hosted deployment
 * with no auth so that "nobody exposes a shell by forgetting a variable". The same argument says
 * the first-owner claim cannot be granted by *arrival order alone*. So: claiming a fresh
 * deployment requires a bootstrap code the operator can see and the internet cannot — printed to
 * the boot log / systemd journal, or preset by the operator.
 *
 * Three modes, resolved from env, exactly like `auth-boot-gate.ts` resolves D1's five rows:
 *
 * | env | mode | effect |
 * |---|---|---|
 * | `CEZ_AUTH` unset/`none` | `open` | never consulted — the onboarding routes are not mounted at all |
 * | `CEZ_AUTH_BOOTSTRAP_TOKEN=<secret>` | `preset` | that exact value must be supplied to claim the deployment |
 * | (default, `CEZ_AUTH` on) | `generated` | a fresh 128-bit code is minted at boot and printed once |
 * | `CEZ_AUTH_BOOTSTRAP_OPEN=1` | `open` | the operator says out loud that whoever signs in first may claim it |
 *
 * `generated` is the default on purpose: it is the mode that is safe when the operator does
 * nothing, and the code costs them one glance at `journalctl -u cezar`. `open` restores phase 4's
 * original behaviour for anyone who genuinely wants it (a single-user loopback deployment testing
 * the OIDC flow, per D1's table) — but it has to be *said*.
 *
 * This gate is one-shot by construction: it is only ever consulted by `POST /auth/onboarding/org`'s
 * legacy branch, whose own `IdentityStore#claimOrg` guard (`orgs.length > 0`, checked under the
 * identity store's write lease) makes that branch unreachable the moment any org exists. A leaked
 * code after onboarding grants nothing for the deployment's first org.
 *
 * **D11 (5b/5c/8 scaffold pass, ADDED 2026-08-07): the SECOND org and later do not use this
 * module at all.** `POST /auth/onboarding/org`'s `orgSlug` branch is gated by that org's own,
 * per-org code instead (`./org-claim-token.ts`) — a deliberately separate mechanism, because this
 * module's one code is process-wide and the whole point of D11 is that org one's owner (who
 * already holds this code, having used it) must not also be able to claim org two with it.
 */

export type BootstrapClaimMode = 'open' | 'preset' | 'generated';

export interface BootstrapClaim {
  /** `false` only for `open`. When `true`, `POST /auth/onboarding/org` must be handed a matching
   *  `bootstrapToken` or it answers 403. */
  readonly required: boolean;
  readonly mode: BootstrapClaimMode;
  /** The secret itself. Present iff `required`. Never sent to a client — the onboarding status
   *  route reports only the BOOLEAN `bootstrapTokenRequired`. */
  readonly token?: string;
}

/** Mints the `generated` code. 128 bits, hex — long enough to be unguessable, short enough to
 *  retype off a terminal without hating it. Injectable so a test can pin the value without
 *  reaching into `crypto`. */
export type MintToken = () => string;

const defaultMint: MintToken = () => randomBytes(16).toString('hex');

export function resolveBootstrapClaim(
  env: NodeJS.ProcessEnv,
  mint: MintToken = defaultMint,
): BootstrapClaim {
  // Auth off ⇒ `/auth/*` is never mounted, so nothing can consult this. Returning `open` (rather
  // than minting a code nobody will ever be asked for) keeps D1's "unset means zero I/O" literally
  // true even if some future caller reaches this on the auth-off path: no randomness is drawn, no
  // banner is produced, nothing is stored.
  if (resolveAuthProvider(env) === 'none')
    return { required: false, mode: 'open' };
  if (env.CEZ_AUTH_BOOTSTRAP_OPEN === '1')
    return { required: false, mode: 'open' };
  const preset = env.CEZ_AUTH_BOOTSTRAP_TOKEN?.trim();
  if (preset) return { required: true, mode: 'preset', token: preset };
  return { required: true, mode: 'generated', token: mint() };
}

/**
 * Constant-time comparison of a supplied code against the claim. `timingSafeEqual` throws on a
 * length mismatch, so the lengths are compared first and an unequal length answers `false` —
 * which does leak the code's length, a value that is fixed and public for the `generated` mode
 * anyway.
 *
 * Unlike `session.ts`'s own note about session ids, constant-time genuinely matters here: the
 * `preset` mode lets an operator choose a short, human-picked secret, and this is a *single*
 * comparison against one known value, which is the exact shape a timing oracle attacks.
 */
export function matchesBootstrapClaim(
  claim: BootstrapClaim,
  supplied: string | undefined,
): boolean {
  if (!claim.required) return true;
  if (claim.token === undefined) return false; // unreachable: `required` implies a token
  if (supplied === undefined) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(claim.token, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * What `serveCommand` prints at boot. `undefined` when there is nothing to say — an already
 * onboarded deployment (`hasOrg`), a preset code (the operator already has it), or `open`.
 *
 * `hasOrg` is passed in rather than read here because this module must stay free of filesystem
 * access: it is imported on the `CEZ_AUTH`-on path only, but keeping it pure is what lets
 * `bootstrap-claim.test.ts` walk every row of the table above without a temp directory.
 */
export function bootstrapClaimBanner(
  claim: BootstrapClaim,
  hasOrg: boolean,
): string | undefined {
  if (hasOrg) return undefined;
  if (claim.mode === 'generated') {
    return (
      '\n  ⚑ This deployment has no organization yet. The first sign-in that supplies the code\n' +
      '    below claims it and becomes its owner — everyone after that needs an invite.\n' +
      `\n      bootstrap code:  ${claim.token}\n` +
      '\n    A new code is minted on every restart until the organization exists. Set\n' +
      '    CEZ_AUTH_BOOTSTRAP_TOKEN to pin your own, or CEZ_AUTH_BOOTSTRAP_OPEN=1 to let\n' +
      '    whoever signs in first claim it with no code.\n'
    );
  }
  if (claim.mode === 'open') {
    return (
      '\n  ⚠ This deployment has no organization yet and CEZ_AUTH_BOOTSTRAP_OPEN=1 is set —\n' +
      '    whoever signs in first becomes its owner, and an owner can run shell commands on\n' +
      '    this host (POST /api/v1/workflows → spawn bash). Unset it to require a code.\n'
    );
  }
  return undefined; // 'preset': the operator chose the value and already knows it.
}

/**
 * The process-lifetime claim. Resolved once at module load — which only ever happens on the
 * `CEZ_AUTH`-on path, because `src/index.ts` reaches this module (and `./onboarding-routes.ts`,
 * which imports it) through the same `gate.provider !== 'none'` dynamic import as the rest of
 * `auth/`. One instance, shared by the route that checks it and the boot banner that prints it,
 * via the ESM module cache — never two resolutions that could mint two different codes.
 */
export const bootstrapClaim: BootstrapClaim = resolveBootstrapClaim(
  process.env,
);
