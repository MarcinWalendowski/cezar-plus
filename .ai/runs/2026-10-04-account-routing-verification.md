# Cezar account routing verification — 2026-10-04

Status: implemented and verified. Spec: `.ai/specs/2026-10-04-account-routing-verification.md`.
The tested source extends upstream integration `a8c58088` (upstream `1b13522d`, 0.14.0).
The [33 migrated upstream features](2026-10-03-upstream-sync-integration.md) remain intact.
Source delivery goes to `MarcinWalendowski/cezar-plus` origin/main only. The operator
checkout remains clean at `ef59fa72`; no active operator cockpit process was found,
and this work does not activate it.

## Observed defects and repairs

A real isolated HTTP reproduction loaded eight configured accounts as seven:
global bare-ID deduplication discarded Codex `pb` beside Claude `pb`. A Codex PB
status request reported the Claude login. Storage now preserves `(provider,id)`;
management routes, internal usage caches and cockpit actions/labels use qualified
identity, while stored IDs, selections and public usage-response IDs remain unchanged.
Unique legacy routes still work; ambiguous bare routes refuse with 409 before details,
probe, OS open or mutation. Atomic writes recheck the pair; deletion clears only the
removed provider's references.

Continue admission now checks its intended account, preserves recorded affinity
when defaults change, uses the target provider's selection on a provider switch and
resolves pools before model and session-affinity decisions. Pools exclude disabled
providers, persist a concrete pair and do not advance their cursor on refusal.
Native sessions resume only for the same provider/account; switches transfer context
into a fresh native conversation.

## Actual local subscription results

No dry-run provider, ambient API key or custom billing gateway was used for the live
matrix. Claude uses its local Claude.ai login; Codex uses its local ChatGPT login.
Login/catalog preparation alone is not counted as inference. Native Claude init events
and each owning Codex rollout's `turn_context` confirm actual models and effort.
Unique file values were never included in the request, so correct responses require
reading the appropriate disposable project/worktree.

| Provider / local account | Models actually executed through Cezar | Result |
| --- | --- | --- |
| Claude / pb | Sonnet 5.5, Opus 5.5, Fable 5.1 | Real marker turns and continuations passed. |
| Claude / mwalendo | Opus 5.5, Sonnet 5.5 | Real marker turns and account/default switching passed. |
| Claude / gmail | Fable 5.1 requested | Native weekly-limit rejection; resets Oct 7, 11am Europe/Warsaw. No substitution counted as success. |
| Claude / mw | Sonnet requested | Named profile is logged out; refused without state mutation. |
| Codex / lq | GPT-6 Luna, GPT-6.1 Sol | Real turns, wildcard routing, restart persistence and native resume passed. |
| Codex / pb | GPT-6.1 Sol, GPT-6 Luna | Real turns/model switch and mixed workflows passed; low-effort investigation below retains intermittent failures. |
| Codex / mwalendousa | GPT-6 Luna | Real turn passed. |
| Codex / mw2gmail | GPT-6.1 Sol | Real turn passed. |

| Scenario | Executed proof |
| --- | --- |
| Two projects | Separate committed alpha/beta markers, worktrees and stores; wrong-project run GET returns 404. |
| Selection precedence | Inherited project selection, explicit override, changed project/machine defaults and target-provider selection all passed. |
| Resume and switching | Same account/model and changed model retain the session; changed account/provider use a fresh session and preserve the prior nonce context. |
| Shared PB identifiers | Both accounts survive HTTP loading, distinct management reads/settings rows, correct per-step attribution and native sessions. |
| Pools | Provider-specific start/Continue, wildcard start/Continue and disabled-provider exclusion passed; concrete identities/cursors verified. |
| Mixed workflow | Claude PB Sonnet → Codex PB Sol; Claude PB Sonnet → Codex PB Luna medium; two further Luna low/auto chains passed. |
| Restart | Run/model/account/session metadata unchanged after isolated server restart; native continuation resumes the recorded session. |
| Real cockpit | Both provider PB rows, Claude/Codex task badges, actual `/p/:id` overviews and clicks into each project's own task passed eight recorded checks; captures inspected. |

## Low-effort Luna investigation

Two initial mixed-workflow PB/Luna low-effort attempts emitted false tool-unavailable
answers without reading the marker; a direct built-adapter full second-step control
also failed. These remain failed probes, not unavailable subscriptions or retroactive
passes. Native records confirm the requested account, model, low effort, auto summary
and correct working directory. Cezar did not receive a local tool-call attempt in them.

Six initial adapter controls passed five cases: bare and first-step low/auto PB,
second-step low/none PB, second-step medium/auto PB and second-step low/auto LQ;
the PB second-step low/auto case failed. Four alternating low/auto and low/none repeats
then all passed, so the summary setting is not a demonstrated cause. The installed
CLI catalog supports both low effort and reasoning summaries. Direct native CLI PB/Luna
controls passed at low and xhigh; the full second-step prompt with low/auto also called
`cat` and returned the correct unique value.

Finally, two fresh actual Cezar mixed-provider chains passed at unchanged low/auto,
with native `exec`, correct model/account/worktree/effort and persisted step/session
records. No deterministic routing, tool-provisioning, effort or summary defect was
identified. The intermittent failures' cause remains unproven. No automatic effort,
model or summary override was added, and this record does not claim every request passed.

## Gates and retained evidence

- Sanitized Node 24.20.0: typecheck/build passed; 15,119 source tests passed,
  9 conditional skips; Node tests 47/47 and package tests 47/47. No lint script
  or lint configuration exists in this repository.
- Canonical browser suite: all 43 files, 242 passed tests, 5 intentional capability
  skips; `TEST_E2E_STATUS=passed`, 43 nonempty ffprobe-valid WebMs and identical
  tracked fingerprints. Earlier failures and videos remain retained.
- Browser settings repairs only synchronize on rendered/persisted state around
  pending mutations. Exact API persistence and cold-reload assertions and timeouts
  remain unchanged. The worktree-retention diagnostic captured editing the next
  value before the prior save disabled/reconciled its form.
- Fresh actual two-node cluster: all 21 assertions passed, including restart,
  offline replication, remote/local dispatch, claims and worker-policy refusal.
- Final exact-PID cleanup found no updated-build HTTP server or broker process;
  every disposable fixture is removed and the shared mock descriptor is stopped.
  Operator checkout, account registry and workspace config hashes are unchanged.
  One harness cleanup hit an ESRCH race after its target exited; the subsequent
  owned-fixture cleanup proof confirms zero survivors and removal.

Evidence is retained locally under ignored
`.ai/qa/artifacts_upstream_sync/reverify-2026-10-04/`: final-gates, first-gates-red,
first-live-attempt, live-server-live-evidence, mixed-sol-control,
native-medium-effort-proof, adapter-luna-controls, adapter-luna-summary-abab,
native-full-chain-low-auto, low-chain-replay-live-evidence/native-low-chain-proof,
fresh-controls-live-evidence/live-ui-final-complete and final-cleanup-proof.
The final canonical browser run is `e2e-canonical-2026-10-04T06-46-33.805Z` in its parent.
Nine source skips require optional live vendor/S3 access, Linux /dev/shm or GNU sed;
five browser skips cover the disabled follow-up inbox and constrained single-project mode.
Native desktop was verified in the original integration and was not rerun for this
account-routing change.
