# Brief: credentials-unavailable auto fallback

**Task:** `90836867-2ad6-4c51-abfd-b242ba46da6d`
**Step:** Gather the record only. This is not a spec and contains no implementation.

## Problem in this repository's terms

cezar shows a pre-flight blocking message, `"${LABEL[provider]} credentials are unavailable.
Authorize it in Settings → Agents → Providers."`, and refuses the action, even when another
active account for that same provider, or an entirely different provider (Claude vs Codex), is
connected and could run the task instead. The owner's ask: when the specifically-required
provider/account has no live credentials, fall back to whatever "auto"/pool selection would pick
— across providers, not just within one — instead of blocking.

The message is built by `unavailableProviderMessage(required, response)`
(`packages/cezar/src/server/provider-action-gate.ts:57-71`) and returned by
`providerActionError()` (`packages/cezar/src/server/server.ts:1520-1542`), a synchronous
pre-flight gate called from 9 route handlers before any run/continuation dispatch — start run,
send message, continue, retarget (`server.ts:2571, 4685, 5266, 5291, 5416, 5459, 5510, 5612,
6185`). It fires when a required provider's status row is not `'connected'`. The `required`
provider comes from `providerForActiveRun`/`providerForExistingRun` (the run's pinned
`runner`/step `backend`) or `providersRequiredByWorkflow` (a workflow's per-step pin) — it is
never "auto" at this layer. The client has an independent mirror of the same check:
`providerAvailability()` in `packages/web/src/routes/task-thread/active-provider.ts:31-51`,
producing the identical string at `active-provider.ts:47`. ("Configure providers" is separate
link text rendered by several UI components — `new-task.tsx`, `inbox.tsx`, `ask-card.tsx`,
`review-panel.tsx`, `provider-banner.tsx`, `thread-composer.tsx` — cosmetic, not decision logic.)

Both server tests (`provider-action-gate.test.ts`, `provider-action-gating.test.ts:349-462`)
assert this exact blocking string and the one fallback that already exists; neither exercises a
cross-provider disconnected-account case.

## What the record already decided

1. **A partial, same-provider-only fallback already exists and is tested.**
   `poolHasConnectedAccount(provider, repoRoot)` (`server.ts:1475-1495`) was added after a
   production incident (`da0119ec`) where a project pooled onto two Claude logins still 409'd
   despite the other login being healthy. It only fires when the route is `pool:*`/`pool:provider`
   in `agent-accounts.json`, and by explicit design (comment at `server.ts:1485-1488`, "a wildcard
   must not cross to another one here either") it never crosses to a different provider. A run
   pinned to one specific dead account, not a pool route, gets no fallback check at all.

2. **A real, tested, cross-provider reroute mechanism already exists — but only for quota holds,
   not for connection status.** `rerouteExplicitAccountIfLimited` /
   `resolvePoolForDispatch`/`resolvePoolForProvider` (`workflows/run.ts`,
   `agent-route-select.ts`) can move a limited Claude account onto Codex
   (`.ai/specs/2026-08-24-continuation-reroute-held-account.md:70-77`). It is keyed entirely off
   `isLimited()`/`accountUsageKey` (usage-limit envelopes), never off `status !== 'connected'`
   (never-authorized/revoked/logged-out). It also lives inside `execute()`/`continueRun()`/
   `runContinuation()` — code the blocking pre-flight gate never reaches, because
   `providerActionError` returns and stops the request before dispatch is ever invoked.

3. **The owner's "never blocked" ruling is written and implemented for quota exhaustion on
   already-authorized accounts, not for never-authorized/logged-out credentials as a distinct
   class.** KB `notion-5ce876561d8f` ("A task is never blocked by a quota limit," 2026-08-23):
   *"Task should never be blocked. if model is unavailable or limit is hit it should always
   automatically proceed on next available provider & model."* Every one of the seven specs that
   implement this ladder —
   `.ai/specs/2026-08-23-never-block-a-task.md` (the account→sibling→cross-provider
   downgrade→hold-and-wait ladder, gated by `resources.fallbackAcrossAccountsWhenLimited`),
   `2026-08-23-usage-limit-hold-account.md`, `2026-08-23-step-runner-account-resolution.md`,
   `2026-08-23-retarget-task-to-another-engine.md`, `2026-08-24-reroute-checks-dangling-account-key.md`,
   `2026-08-24-continuation-reroute-held-account.md`, `2026-08-24-second-codex-account-balancing.md`,
   plus the foundational `2026-08-16-agent-account-usage-routing.md` — uses only quota/limit/held
   vocabulary (`limited`, in-flight, dispatch-order, quota band). Grepping all seven for
   `credential|unauthoriz|logged out|revoked` returns zero hits. `2026-08-23-retarget-task-to-
   another-engine.md` states its own scope boundary directly: the setting governs "whether an
   explicit, non-pool account may be routed around when it is out of quota" — quota, not auth
   state. **This is the central judgment call for the next step**: is "credentials unavailable"
   the same class of unavailability the owner's ruling already covers ("model is unavailable" read
   broadly), or a genuinely undecided second class that needs its own explicit ruling before a
   spec builds on it?

4. **No duplicate or in-flight work exists.** Checked and clear: `cezar todo list` (4 open items,
   none related — cluster/deploy/sweep-race topics only), `git log --grep` over
   `credential|provider|account` (only the seven-spec family above, none touching
   `provider-action-gate.ts`'s disconnected-status check), `cez kb search` for "credentials are
   unavailable" / "Configure providers" / "logged out account block task" (no new hits beyond
   generic unrelated notion pages), and the `.ai/specs/briefs/` directory (7 files, all
   2026-08-24, none on this topic). Safe to proceed with a new spec.

## Code actually involved

- `packages/cezar/src/server/provider-action-gate.ts:57-71` — `unavailableProviderMessage`, builds
  the blocking string.
- `packages/cezar/src/server/server.ts:1475-1542` — `poolHasConnectedAccount` (same-provider
  fallback) and `providerActionError` (the gate itself; 9 call sites listed above).
- `packages/web/src/routes/task-thread/active-provider.ts:31-51` — client-side mirror,
  `providerAvailability`, same string at line 47; will drift from any server-side fix unless
  updated in the same change.
- `packages/cezar/src/workflows/run.ts`, `packages/cezar/src/workflows/agent-route-select.ts` —
  existing cross-provider reroute machinery (`rerouteExplicitAccountIfLimited`,
  `resolvePoolForDispatch`/`resolvePoolForProvider`), currently quota-only and post-dispatch; the
  natural place to extend, or the natural pattern to mirror, for a pre-flight
  credentials-unavailable case.
- `packages/cezar/src/server/provider-action-gate.test.ts`,
  `packages/cezar/src/server/provider-action-gating.test.ts:349-462` — existing tests asserting
  the current blocking string and the same-provider pool fallback; will need updating for whatever
  fallback behavior a spec chooses.

## Prior decisions this could contradict

- `2026-08-23-retarget-task-to-another-engine.md`'s explicit scope line (fallback governs
  quota-routing of a non-pool account, not auth state) would be extended, not merely
  implemented, by treating disconnected credentials as fallback-eligible. That's a scope
  widening the spec author should call out explicitly rather than silently reinterpret.
- The same-provider `poolHasConnectedAccount` comment ("a wildcard must not cross to another one
  here either," `server.ts:1485-1488`) was a deliberate boundary, not an oversight — a spec that
  removes it needs to say why the reasoning that produced it no longer applies to the
  credentials-unavailable case specifically.
- A workflow step or run that explicitly pins a provider (`providersRequiredByWorkflow`,
  `runner`/`backend`) may be pinned for a capability reason, not convenience. Auto-rerouting a
  hard pin to a different provider could silently violate that intent — this is the same
  "explicit, non-pool account" boundary spec #`2026-08-23-retarget-task-to-another-engine.md`
  already drew for quota.

## Open questions a spec will have to settle

1. **Scope of "auto."** Does "just continue on auto" mean: only fall back within the required
   provider's pool (extending `poolHasConnectedAccount`'s existing same-provider check to also
   run for pinned/non-pool routes), or does it mean genuinely cross-provider (Claude down → run on
   Codex instead), matching the literal wording of the task ("more active claude accounts OR codex
   accounts")? The existing cross-provider reroute code only exists for quota holds today.
2. **Where does the fallback happen — before the gate, or by removing the gate's blocking power?**
   Should `providerActionError`/`unavailableProviderMessage` be extended to check pool
   availability across all providers before refusing (mirroring `poolHasConnectedAccount` but
   widened), or should the pre-flight block be removed for this case entirely and the action
   allowed to proceed into `execute()`/dispatch, letting the existing (or a newly extended)
   reroute machinery resolve the actual account/provider at dispatch time?
3. **Does this override an explicit provider pin, or only apply to `pool:*`/`auto` routes?** A
   step or workflow that names a provider deliberately is a different case from one that says
   "auto" and gets whatever's available. The spec must decide whether "credentials unavailable"
   fallback respects an explicit pin (never reroute a hard pin) or overrides it (any single-
   provider block is eligible for cross-provider rescue) — the retarget-to-another-engine spec's
   existing boundary suggests the former, but the owner's "never blocked" ruling suggests the
   latter reading is closer to intent.
4. **Do the two existing tests get updated to assert fallback-then-proceed, or stay as regression
   coverage for a narrower still-blocking case (e.g., zero connected accounts anywhere)?**
   Blocking should presumably still occur when truly no account/provider is available at all —
   the spec needs to define that terminal case precisely.
5. **Client/server duplication.** `active-provider.ts`'s client-side check and
   `provider-action-gate.ts`'s server-side check independently produce the same string today. Does
   this fix need to land in both to avoid a UI banner that still blocks after the server would
   permit the action, and is there a reason they're duplicated rather than shared that the next
   step should preserve?

## What could not be found

- No spec, commit, KB entry, or todo anywhere addresses "credentials unavailable" /
  never-authorized / logged-out as a routing signal — confirmed by direct grep of all seven
  related specs and by KB search; this really is greenfield within the existing account-routing
  system, not a rediscovery of settled ground.
- No explicit owner ruling exists yet on whether "never blocked" was meant to cover
  never-authorized accounts the way it covers quota-exhausted ones. The KB note's own title and
  body say "quota limit" throughout; whether that phrase was meant narrowly or the owner would
  extend it on being asked is unknown and worth confirming rather than assuming either way.
