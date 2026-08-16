/**
 * Server capabilities reported by `/api/health` — the UI hides what the server
 * says isn't there, and the matching endpoints refuse as defense in depth.
 *
 * `localHandoff` (cockpit-ui redesign spec §"Deployment modes — local vs
 * hosted"): the default deployment is `npx cezar-cli` on localhost, where
 * handing a session off to a local terminal/editor makes sense. On a VPS/remote
 * box it doesn't: `CEZ_REMOTE=1` (or binding a non-loopback host) switches to
 * hosted mode — the UI hides every local-machine affordance and the open-in-*
 * endpoints 409.
 *
 * `followups` (spec 007, #444, #471): the global follow-up inbox is **opt-in**
 * via `CEZ_FOLLOWUPS=1` and off by default. Off, agents are never told to write
 * `todos.json` (they get `HANDOFF_ONLY_INSTRUCTIONS` and an empty
 * `CEZ_TODOS_FILE`), the Inbox nav item is gone and the inbox endpoints refuse.
 * The per-task handoff journal is independent and runs either way.
 *
 * `singleProject` (spec 2026-07-21-cez-single-project): the workspace is
 * deliberately constrained to the launch project when `CEZ_SINGLE_PROJECT=1`.
 * Like the other opt-in capabilities, activation is strict: no other spelling
 * enables it.
 *
 * `automations` (spec 2026-07-25-github-automations, #801): GitHub automations
 * are **opt-in** via `CEZ_AUTOMATIONS=1` and off by default. Off, the
 * `Automations` nav item is gone everywhere it is rendered, the
 * `/automations*` endpoints refuse, and the workspace scheduler never polls
 * GitHub — the flag removes the behavior, not only the UI. Activation is
 * strict, like the two capabilities above. Nothing on disk is touched:
 * definitions, receipts and high-watermarks survive the flag being off, so
 * unsetting it and restarting restores the feature wholesale.
 *
 * Usage presentation: token counts and monetary cost stay visible by default.
 * `CEZ_HIDE_TOKEN_USAGE=1` and `CEZ_HIDE_COST=1` hide them independently;
 * legacy `CEZ_HIDE_TOKEN_METRICS=1` remains the master hide-all switch. None
 * changes collection, persistence, events, or API run records.
 *
 * The central-hub scaffold (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`, D4/D19): five more
 * opt-in capabilities, each strictly gated on the exact string `'1'` and each currently inert.
 *
 * **CORRECTED 2026-08-06 — the flag-off byte-identity claim below was false as written.** This
 * docblock used to say "with all five unset, `/api/v1/health` and the agent system prompt stay
 * byte-identical to the pre-scaffold build". Measured against the pre-change build (`d3aff0a`)
 * with every `CEZ_*` var unset, only the second half holds:
 *
 * - **Agent system prompt: byte-identical.** `loadKnowledgeSummary` returns `undefined` off the
 *   exact-`'1'` gate, `knowledgeSystemPrompt(undefined)` returns `undefined`, and
 *   `composeSystemPrompt` drops it — the composed prompt and `additionalDirectories` are
 *   unchanged, verified by hashing both builds' output.
 * - **`/api/v1/health`: NOT byte-identical.** The five keys below are emitted unconditionally, so
 *   the flag-off body grows by `"knowledge":false,"sources":false,"notes":false,
 *   "workspaceViews":false,"notify":false` (933 → 1019 bytes on an otherwise identical fixture).
 *
 * That is a deliberate shape, not a slip, and it is why the claim had to be corrected rather than
 * the code: `capabilitiesSchema` (`packages/contract/src/health.ts`) declares all five as required
 * `z.boolean()`, `capabilities.test.ts`'s "independent of the deployment mode" case asserts the
 * full 11-key object with `toEqual`, and the pre-existing opt-in capability `followups` is itself
 * always present as `false`. Omitting a key when off would contradict all three. What "opt-in"
 * buys here is behavioural, not byte-level: no index, no watcher, no timer, no route, no nav item
 * and no prompt bytes. If byte-level identity of the health body is genuinely required, it is a
 * contract-shaped decision (optional keys, or a nested `capabilities.experimental` object) and
 * belongs in the plan before the code, not in a quiet edit here.
 *
 * `knowledge` (`CEZ_KB`), `sources` (`CEZ_SOURCES`) and `notify` (`CEZ_NOTIFY`)
 * are per-project features and are independent of `singleProject`. `notes` (`CEZ_NOTES`) and
 * `workspaceViews` (`CEZ_WORKSPACE_VIEWS`) are cross-project by nature, so both report `false`
 * under `CEZ_SINGLE_PROJECT=1` regardless of their own flag — a single-project cockpit has no
 * "every registered project" to aggregate or fan a note out across.
 *
 * `CEZ_AUTH` (D1 of `.ai/specs/2026-08-06-org-team-auth-onboarding.md`) is read by
 * `resolveAuthProvider` below and is **not** part of `resolveCapabilities`'s result: it is
 * server-side policy the cockpit is never told, and keeping it out is what leaves the auth-off
 * health payload byte-identical to the pre-auth build. Unlike every boolean above, an unset
 * `CEZ_AUTH` is not merely "off" — it is the whole npm zero-config product, so
 * `resolveAuthProvider` treats anything other than the two exact provider spellings as `'none'`
 * rather than trying to guess what a typo meant.
 */

import { followupsEnabled } from '../handoff.ts';
import type { AuthProvider, Capabilities } from '@loki-labs/better-cezar-contract';

/** Every IPv4 address in 127.0.0.0/8, anchored. Anchoring is load-bearing: a
 *  `startsWith('127.')` test also matches attacker-controlled *hostnames* like
 *  `127.0.0.1.evil.com`, which is exactly the DNS-rebinding bypass #426 is
 *  about — see `isLoopbackHostHeader`. */
const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** The IPv6 loopback in the canonical form `expandIpv6` emits. */
const LOOPBACK_V6 = '0:0:0:0:0:0:0:1';

/** Expand an IPv6 literal to all 8 groups, lowercase and without leading zeros
 *  (`::1` → `0:0:0:0:0:0:0:1`), or `null` when it is not a valid literal.
 *
 *  Canonicalizing rather than merely *recognizing* matters: `Host` carries
 *  whatever spelling the client sent, but `new URL().hostname` compresses
 *  (`[0:0:0:0:0:0:0:1]` → `[::1]`), so the two only compare equal on a common
 *  form. */
function expandIpv6(h: string): string | null {
  const halves = h.split('::');
  if (halves.length > 2) return null;
  let groups: string[];
  if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves[1] ? halves[1].split(':') : [];
    if (head.length + tail.length > 7) return null;
    groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  } else {
    groups = h.split(':');
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16).toString(16)).join(':');
}

/** Canonical hostname of an authority: port and IPv6 brackets removed, IPv6
 *  expanded, zone id and FQDN trailing dot dropped, lowercased.
 *  `[::1]:4321` → `0:0:0:0:0:0:0:1`, `localhost.:4321` → `localhost`.
 *
 *  Strict by construction: an authority that does not parse as one of the three
 *  legal shapes returns `''`, which no allowlist matches. Being lax here is a
 *  security bug, not a convenience — a parser that merely *finds* a loopback
 *  name inside the header would accept `[::1]@evil.com` or `127.0.0.1:evil.com`. */
export function normalizeHostname(host: string): string {
  // 1. Bracketed IPv6, optionally with a port: `[::1]`, `[::1%25eth0]:4321`.
  //    The end anchor is load-bearing — without it `[::1]@evil.com` → `::1`.
  const bracketed = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return expandIpv6(stripZone(bracketed[1]!.toLowerCase())) ?? '';

  // 2. A bare IPv6 literal cannot carry a port (no brackets ⇒ every colon
  //    belongs to the address), so anything with >1 colon is taken whole.
  if (host.split(':').length > 2) return expandIpv6(stripZone(host.toLowerCase())) ?? '';

  // 3. `name` or `name:port`, where the port must actually be digits.
  const plain = host.match(/^([^:[\]]*)(?::(\d+))?$/);
  if (plain) return plain[1]!.toLowerCase().replace(/\.$/, '');

  return ''; // unparseable ⇒ matches no allowlist
}

/** Drop an IPv6 zone id (`fe80::1%eth0`), anchored to the end so a `%` inside a
 *  registrable hostname can never truncate it down to a loopback name. */
function stripZone(h: string): string {
  return h.replace(/%[a-z0-9._~-]+$/, '');
}

/** True when the hostname names this machine and nothing else. Expects the
 *  canonical output of `normalizeHostname`. */
function isLoopbackName(hostname: string): boolean {
  return hostname === 'localhost' || LOOPBACK_V4.test(hostname) || hostname === LOOPBACK_V6;
}

/** True for bind hosts that only the local machine can reach. Undefined = the
 *  default bind (127.0.0.1), hence trusted — this is a *configuration* value we
 *  chose, not a request header. Do NOT use this on attacker-controlled input;
 *  use `isLoopbackHostHeader`, which fails closed on a missing host. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  return isLoopbackName(normalizeHostname(host));
}

/** True for a request's `Host`/`Origin` hostname when it names this machine.
 *  The untrusted-input twin of `isLoopbackHost`: a missing or unparseable host
 *  is **untrusted** (false), because absent is not the same as "we defaulted to
 *  loopback" once the value arrives over the wire (#426). */
export function isLoopbackHostHeader(host: string | null | undefined): boolean {
  if (!host) return false;
  return isLoopbackName(normalizeHostname(host));
}

/**
 * `CEZ_AUTH` selects the provider (D1): `'oidc'`, `'google'` or `'supervisor'` exactly, everything
 * else — including unset — is `'none'`. `'none'` is what the npm default (no env set at all)
 * resolves to, and it MUST stay zero-I/O: nothing beyond this string comparison runs to reach that
 * answer, which is what lets `packages/cezar/src/index.ts`'s boot gate and `requirePrincipal` in
 * `server.ts` both import the Phase 2/3 identity module only on the branch where this returns
 * something other than `'none'`.
 *
 * `'supervisor'` added 2026-08-07 (D10, phase 6/7 fill unit 5 — see `authProviderSchema`'s own
 * doc comment, `@loki-labs/better-cezar-contract`, for what this value means and does not mean). This
 * function needed exactly the one added literal below — the boot gate, the D4 project-team
 * registry seam (`server/server.ts#openProjectTeamRegistry`) and every other reader of this
 * function's return value already treat "any non-`'none'` provider" uniformly.
 */
export function resolveAuthProvider(env: NodeJS.ProcessEnv = process.env): AuthProvider {
  return env.CEZ_AUTH === 'oidc' || env.CEZ_AUTH === 'google' || env.CEZ_AUTH === 'supervisor' ? env.CEZ_AUTH : 'none';
}

/**
 * `CEZ_BACKUP=1` (exact string) ⇒ the provider-agnostic platform backup subsystem exists
 * (spec `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`, D4). Unset — or any other
 * spelling — is off: no due-scheduler job, no network, no credential read, and every
 * `/api/v1/backup` mutator answers `409`.
 *
 * **Deliberately its own reader and NOT a member of `resolveCapabilities`/`capabilitiesSchema`**,
 * exactly like `resolveAuthProvider` above and for the same reason (see `authProviderSchema`'s
 * docblock in `@loki-labs/better-cezar-contract`): the plan requires the flag-off `/api/v1/health`
 * body to stay byte-identical to today, and a required capability key would grow it and force the
 * fixture-wide edit that makes the health-payload control meaningless. The cockpit learns whether
 * backup is on from `GET /api/v1/backup`'s own `enabled` field, never from health — the same way
 * the account section probes rather than reading a capability key. The routes and the scheduler
 * bootstrap read this function directly.
 */
export function backupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_BACKUP === '1';
}

/** `CEZ_REMOTE=1` or a non-loopback bind host ⇒ hosted mode (no local handoff).
 *  `CEZ_FOLLOWUPS=1` ⇒ the follow-up inbox exists (#471).
 *  `CEZ_AUTOMATIONS=1` ⇒ GitHub automations exist (#801).
 *
 *  Read per request — cheap, and tests/ops can flip `CEZ_REMOTE` live. `followups` is honest
 *  per request too, but flipping it ON at runtime is only half a switch: the per-dataDir
 *  todos watch (step 2.3) is created by an SSE subscription, so connections opened while the
 *  flag was off never subscribed and get no live inbox updates until they reconnect. Hence
 *  the UI's "set CEZ_FOLLOWUPS=1 and restart cezar" wording — treat it as a boot-time flag.
 *
 *  `automations` carries the same caveat and for the same reason: the workspace scheduler is
 *  started once, on the server's `listening` event, so flipping the flag on afterwards gates
 *  the routes open without ever starting the poller. Boot-time flag, same wording. */
export function resolveCapabilities(env: NodeJS.ProcessEnv = process.env, bindHost?: string): Capabilities {
  const hideAllUsage = env.CEZ_HIDE_TOKEN_METRICS === '1';
  const tokenUsageMetrics = !hideAllUsage && env.CEZ_HIDE_TOKEN_USAGE !== '1';
  const costMetrics = !hideAllUsage && env.CEZ_HIDE_COST !== '1';
  const singleProject = env.CEZ_SINGLE_PROJECT === '1';
  const localHandoff = env.CEZ_REMOTE !== '1' && isLoopbackHost(bindHost);
  return {
    localHandoff,
    // Deliberately not re-derived here: RunManager enforces the same predicate,
    // and two spellings of "is the inbox on" would eventually disagree.
    followups: followupsEnabled(env),
    singleProject,
    automations: env.CEZ_AUTOMATIONS === '1',
    tokenMetrics: tokenUsageMetrics && costMetrics,
    tokenUsageMetrics,
    costMetrics,
    knowledge: env.CEZ_KB === '1',
    sources: env.CEZ_SOURCES === '1',
    // Cross-project by nature: false under singleProject regardless of the flag (see the
    // module docblock) — a single-project cockpit has nothing to aggregate or fan out across.
    notes: env.CEZ_NOTES === '1' && !singleProject,
    // ON unless explicitly switched off — the SECOND inverted gate in this object, and the reason
    // is the one D7 already acted on for workspace todos: these boards are the cockpit's main
    // surface on a multi-project install, not an optional side view, and a main path gated on a
    // flag nobody sets fails as SILENCE rather than as an error. The owner ran a full workspace and
    // was told "the workspace git overview is off" by a cockpit that had every number it needed.
    // `CEZ_WORKSPACE_VIEWS=0` is the opt-out; `=1` still reads as on, so no existing install changes
    // behaviour. Still false under `singleProject` — see the module docblock.
    workspaceViews: env.CEZ_WORKSPACE_VIEWS !== '0' && !singleProject,
    notify: env.CEZ_NOTIFY === '1',
    // AND-ed with `localHandoff`, not just the flag: this panel names each login's email, org and
    // plan, and the rest of the agent-profiles family is already withheld in hosted mode for the
    // weaker reason that it echoes host paths. See the field's doc in `contract/health.ts`.
    accountUsage: env.CEZ_ACCOUNT_USAGE === '1' && localHandoff,
    // Inverted, like `workspaceViews` above — `=== '1'` everywhere else, `!== '0'` in these two.
    // (This comment used to claim it was "the one INVERTED gate in this object"; corrected
    // 2026-08-16 when `workspaceViews` joined it, for a different reason: skills predates the
    // capability payload, so absent has to keep meaning on — see the `skills` field in
    // `contract/health.ts` for why that asymmetry is deliberate.)
    skills: env.CEZ_SKILLS !== '0',
    // No `auth` key. `CEZ_AUTH` is read through `resolveAuthProvider` by the two call sites that
    // need it (`requirePrincipal`/`verifyWsUpgrade` in server.ts, the boot gate in index.ts) and
    // is deliberately absent from this payload — see `authProviderSchema`'s own doc comment in
    // `contract/health.ts` for why the auth-off health response has to stay byte-identical.
  };
}

/**
 * D13's local-org-mode predicate (`.ai/specs/2026-08-06-org-team-auth-onboarding.md`), factored
 * out to a single exported function so every caller that needs to ask "is this the ONE topology
 * D13's local-org onboarding actually applies to" asks it the same way, rather than re-deriving
 * the two-part test inline and risking the halves drifting apart.
 *
 * The two halves are `resolveAuthProvider(env) === 'none'` (this topology has no login at all —
 * a hosted `CEZ_AUTH=oidc`/`google`/`supervisor` deployment is never eligible, even if a STALE
 * local org happens to sit in `<CEZ_HOME>/identity` from before auth was turned on) AND
 * `resolveCapabilities(env, bindHost).localHandoff` (this bind is loopback — D1's table has BOTH
 * `hosted + CEZ_AUTH unset + CEZ_ALLOW_UNAUTHENTICATED=1` AND the npm zero-config default resolve
 * `resolveAuthProvider` to `'none'`, and only the SECOND is D13's local-org topology; the first is
 * a network-facing box whose audience is not "one machine").
 *
 * `server.ts`'s per-request principal resolution (`isHostedMode()`, gating `resolveLocalPrincipal`
 * inside the `auth === 'none'` branch) already applies this exact pair inline, per request, with a
 * `Context` to resolve a `Principal` from. This function exists for the callers that have no
 * request to resolve one from at all — `src/index.ts#initWorkspace` (boot-time registration) and
 * `cezar projects add` (`workspace/projects-cli.ts`) — both of which read/write
 * `<CEZ_HOME>/identity/*.json` directly through `auth/local-identity.ts#adoptRegisteredProjectIntoLocalOrg`,
 * not through a resolved principal.
 *
 * **Not a hypothetical guard.** D13's repair round 2 (FIX A3) found a caller of that exact write
 * path — `src/index.ts#initWorkspace`'s own `adoptRegisteredProjectIntoLocalOrg` call, made
 * inline back then — keyed on NEITHER half of this predicate, so it ran unconditionally on every
 * topology, including a hosted `CEZ_AUTH=oidc` deployment: a leftover local org from before auth
 * was turned on would silently keep claiming every newly-registered project forever. The call no
 * longer lives in `src/index.ts` at all — `registered-project-roots.ts#registerAndAdoptProject`
 * is both the fixed call site (it wraps the same `adoptRegisteredProjectIntoLocalOrg` call behind
 * this predicate) and its own test is the mutation-killing regression control for this function
 * specifically.
 */
export function isLocalOrgModeActive(env: NodeJS.ProcessEnv = process.env, bindHost?: string): boolean {
  return resolveAuthProvider(env) === 'none' && resolveCapabilities(env, bindHost).localHandoff;
}
