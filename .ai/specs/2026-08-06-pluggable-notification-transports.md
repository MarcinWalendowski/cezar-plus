# Notification transports

> Plan: `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` (feature F4, packages W1.7, W1.8, W2.4, W2.5, W4.5, W4.7, W4.9).
> The plan's "Resolved decisions" table (D1 to D25) is the authority. D4, D7, D8, D12 and D19 are applied
> here verbatim; **D11 is applied as amended by D23**: transport *instances* remain the model, and an
> instance whose endpoint fans out server-side carries its own per-channel enable list rather than being
> split into one row per channel.
>
> **Companion spec (chat repo):** `chat/.ai/specs/SPEC-417-2026-08-06-cezar-notification-agent.md` defines
> the *receiving* contract the Loki row is configured against: the `agt_cezar` agent, the public
> `POST /notify/v1/events` ingress, its `lok_*` key with `scope = 'notify'`, and its **required**
> `dedupeKey`. That spec owns the wire shape; this one owns the generic sender that can be pointed at it.
> Nothing about that changes the upstream / fork split below: **the Loki row is config, not code.**

## TLDR

cezar has a rich internal event system and **zero outbound notification capability**. The only
thing that ever reaches a person is a page-context `new Notification(...)` fired from React
(`packages/web/src/components/run-notifications.tsx:80-89`), gated on an open tab that is also a
hidden tab with a granted permission (`packages/web/src/lib/notifications.ts:103-109`). There is no
ServiceWorker, no Web Push, no webhook, no email, and no runtime dependency that could send any of
them. Close the tab and every signal is gone, including the transition map itself, which lives in a
`useRef` (`run-notifications.tsx:45`).

That is the gap sitting directly under the product's own headline deployment mode: a VPS you never
sit in front of (`README.md:65-66`, `README.md:280-281`) and a cockpit you check from your phone
"on the train or between meetings" (`README.md:117`).

This spec adds server-side notification transports behind `CEZ_NOTIFY=1`, off by default, wired
into the seam that already exists (`RunStore extends EventEmitter`, `packages/cezar/src/runs/store.ts:407`)
using the observer shape that already works (`packages/cezar/src/server/provider-auth-runtime.ts`).
It ships one generic `webhook` transport whose **instances** are independently enableable, a durable
outbox that survives a cockpit restart, retries with backoff and jitter, and noise control strict
enough that the result is readable rather than mutable. 100% of the code is upstreamable and 0% of
it names Loki.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why |
|---|----------|-----------------|-----|
| Q1 | Transport types or transport instances? | **Instances** (plan D11 **as amended by D23**). One `kind: 'webhook'`; each row in `~/.cezar/notifications.json` carries its own `enabled`, endpoint, event matrix, rate limit and quiet hours. Loki Messages is **exactly one row**, id `loki`, pointed at `POST /notify/v1/events`, whose body carries a `transports` array naming the channels (`imessage`, `telegram`, `whatsapp`). **That array narrows, it does not enable** (plan D23): membership is necessary and not sufficient, because the authority on whether a channel is on is the receiver's `notify_targets.enabled` plus that channel's enrollment (SPEC-417). Omitting the array means every enabled channel; naming a channel that is disabled or unenrolled returns `disabled` / `not_enrolled` in the per-transport result array while the call still answers 202 with nothing delivered. ntfy or Slack would be a second and a third instance. | The literal ask is "each can be enabled independently", and one row plus the narrowing array satisfies it with one edit per change. Do not overstate it: removing `"telegram"` reliably turns Telegram **off**, while adding it turns Telegram on **only if it is already enrolled**, and one-way claims like "add it and it is on" are how a silent non-delivery gets read as a bug in the notifier. It stays a property of config rather than of a class, generalises to another instance for free, and keeps every Loki-specific string out of `src/`. A transport *type* per messenger would have put a vendor name in the source tree on day one. **Three rows was the earlier answer and is wrong:** one endpoint fanning out server-side would receive the same notification three times, minting three dedupe keys for one event and splitting the idempotency domain that SPEC-417's required `dedupeKey` exists to hold, and it would store the per-channel enable flag in two homes at once (the row's `enabled` and the receiver's own target state), which is a setting that does not apply. |
| Q2 | Does WhatsApp ship in phase 1? | **Yes** (plan D12, owner decision 2026-08-06). `whatsapp` is a legal member of the `transports` array from day one, alongside `imessage` and `telegram`, and it needs **no cezar-side work beyond being a legal string**: all three channels reach the same `lokimessages.com` ingress over one endpoint and one API key, so choosing a channel is a JSON array member, never a code path. **The earlier answer was "No, blocked on the 24-hour session window and template approval", and it is superseded.** | The old answer was scoped to the wrong layer. The window and the template approval are real constraints, and they are the *platform's*, not cezar's: cezar POSTs one request to one ingress and never talks to Meta. Whether a channel can deliver right now is the receiver's answer to give, and it gives it per channel in the result array (`window_closed`, `not_enrolled`, `disabled`) while the call still answers 202 with nothing delivered. Silent non-delivery is still the worst failure shape a notifier can have, and the thing that prevents it is that per-transport result array, not the absence of the transport. |
| Q3 | On or off by default? | **Off.** The flag is the exact string `CEZ_NOTIFY=1` (plan D4). Anything else, including `true`, `yes` and unset, means the feature does not exist: no registry, no observer, no timer, no route in the nav, no file created. | `AGENTS.md:14` makes a feature that widens exposure or cost opt-in behind a `CEZ_*` flag. `!== '0'` (unset means on) is the shape the plan explicitly overrode, because it makes a default install do something nobody asked for. |
| Q4 | Where does the subscriber hook in? | The existing in-process fan-out: `store.on('run')` on `RunStore` (`packages/cezar/src/runs/store.ts:407`, emitted from `touch()` at `:973-976`). Not a new bus, not a UI path, not the run path. | `provider-auth-runtime.ts` is the worked precedent for a server-side subscriber added without touching a single UI or workflow file, including its WeakSet dedupe (`:55-68`) and its five wiring call sites. Reusing it means no new lifecycle to get wrong. |
| Q5 | Key on record transitions or on events? | **Transitions** (`('run', RunRecord)`), never `('event', ...)`, with exactly one exception (`provider-auth-required`). | This is "one message per task, not per step" made structural rather than policy. A run emits hundreds of NDJSON events (`appendEvent` at `store.ts:711`, `emitEphemeral` at `:861`) and a handful of status changes. Only a status change can mint a notification, so per-step spam is unreachable rather than merely discouraged. |
| Q6 | Does a transition into the monitoring sub-state notify? | **Never.** `activity === 'monitoring'` (`packages/contract/src/runs.ts:44`) is silent, and a test pins it. | `.ai/specs/2026-07-18-subagent-monitoring-status.md:214-215` already decided this and covered it with a test on the browser path. A second opinion on the server side is how two surfaces start disagreeing about the same state. |
| Q7 | Is there a "needs permission" notification? | **No.** The event enum contains no `permission.*` member. | Nothing in the repo emits `permission.requested`: it is RESERVED, types only (`packages/cezar/src/core/ui-events.ts:310-322`), and `hasPendingPermission` is hard-coded `false` with a comment saying why (`packages/web/src/lib/attention.ts:47-58`). Shipping the row would advertise a signal that can never fire. The ASK path (`run.needs-you`, from the `waiting` transition) is the real one. |
| Q8 | Ship a `queue.drained` event? | Yes, **default off**, opt-in per transport, and the spec says plainly that it is derived. | There is no server-side queue event. Queue position is a client-side render-time index (`packages/web/src/lib/task-groups.ts:130-135`). On a machine at the default `maxParallel: 2` (`packages/cezar/src/workspace/semaphore.ts:110`) it fires after almost every task and just duplicates `run.finished`. Saying so in writing stops a later reader hunting for an emitter that does not exist. |
| Q9 | Where does config live? | `~/.cezar/notifications.json`, **its own file**, never a key in `config.json`. | The exact argument `agent-accounts.json` makes for itself (`packages/cezar/src/workspace/agent-accounts.ts:13-25`, `BACKWARD_COMPATIBILITY.md:153`): a cezar that has never heard of notifications does not open the file, so it cannot drop the keys, whereas living in `config.json` makes survival depend on another version's `.passthrough()` and fails outright whenever any version cannot parse `config.json`. It also wants its own `0600` blast radius, because it names credentials. |
| Q10 | Where does a credential live? | A **reference** to an env var, resolved from `process.env` at send time and never persisted. The documented spelling is `CEZ_NOTIFY_<ID>_TOKEN`. | There is no general secret store in this repo and the codebase refuses to grow one: `server-install/platforms/macosx-ngrok.ts:83` keeps the ngrok authtoken out of cezar's own state file on purpose. The name is load-bearing: `SECRET_NAME_RE` (`packages/cezar/src/core/secret-redaction.ts:28-29`) collects and scrubs a var whose *name* matches `TOKEN`, so this spelling is auto-redacted from every persisted event. |
| Q11 | Is there a `CEZ_NOTIFY_DISABLED` kill switch? | **No.** Dropped. `CEZ_NOTIFY` is the only switch. | An earlier draft carried both. A feature that is off unless a flag equals `'1'` already has a kill switch: do not set the flag. Two env vars answering one question is a state where they can disagree, and the operator has to know which one wins. |
| Q12 | Reuse `wantsAttention`? | **No.** The notifier does not import it and carries no second status list. One mapping table, in `decider.ts`, and a test asserts no bare `RunStatus` literal exists elsewhere under `src/notifications/`. | `wantsAttention` (`packages/web/src/lib/attention.ts:146-148`) excludes `done` and reads a usage-limit hold as non-attention. A remote user does want to hear that the fleet finished and that a task is parked until the window reopens. That divergence is deliberate and recorded here; what is forbidden is two predicates that drift apart silently. |
| Q13 | Any clock-derived field in a GET body? | **Forbidden** (plan D8). Freshness is a stored timestamp plus a stored state. No `ageMs`, no `staleFor`, no `nextAttemptInMs`, no `isOverdue`. | `route-parity.test.ts` issues the same GET three times and compares bodies byte-for-byte. A field that straddles a threshold between two of them is a flaky red gate that gets debugged as alias drift for a day. |
| Q14 | Editable in hosted mode (`CEZ_REMOTE=1`)? | **Yes**, unlike `/api/v1/agent-config`, which 409s. Disclosure is closed on the read side instead. | Agent-config writes are a local-machine RCE surface (`AGENTS.md:82`), which is why `capabilities().localHandoff` gates them (`packages/cezar/src/server/capabilities.ts:127-132`). Notification transports are the opposite case: the remote cockpit is the entire point of the feature. The endpoint URL is write-only, the listing returns host plus path prefix, and no secret is ever echoed. |
| Q15 | Where does the deep link point? | **Discovered before configured**: the `server-install` state's `domain` (`packages/cezar/src/server-install/types.ts:80-82`) gives `https://<domain>`; otherwise `http://127.0.0.1:<port>`. `CEZ_COCKPIT_URL` or a config key overrides. The GET returns `{value, source}`. | The server binds `127.0.0.1` (`AGENTS.md:71`) and genuinely cannot know its public name. The two installs where nobody is watching (`ubuntu-vps`, `macosx-ngrok`) are exactly the two that already recorded a domain. Loopback is the honest fallback and still useful on the box, and showing the *source* means a user with a dead link learns why in one glance. |

## Problem Statement

**Verified: cezar can page nobody.** The complete outbound notification surface of this repo is one
function:

```ts
// packages/web/src/components/run-notifications.tsx:80-89
function fireRunNotification(run: ApiRun): void {
  const N = globalThis.Notification
  if (typeof N !== 'function') return
  ...
  try { new N(content.title, { body: content.body, tag: content.tag }) } catch { /* silent */ }
}
```

Everything about it is browser-local, and each property is fine for what it was built for and fatal
for a headless box:

- **It needs a live page.** `RunNotifications` is a React component mounted in `app.tsx`
  (`run-notifications.tsx:32`). No page, no notifier.
- **It needs the tab hidden and permission granted.** `shouldNotify` requires
  `enabled && hidden && permission === 'granted'` (`packages/web/src/lib/notifications.ts:103-109`),
  and the preference is off by default (`:29`).
- **Its memory dies with the tab.** The "did this run change status" map is a `useRef`
  (`run-notifications.tsx:45`) fed by `diffRunTransitions` (`notifications.ts:80-93`). A reload
  reseeds it from the cache with an empty previous map, which by design notifies about nothing
  (`run-notifications.tsx:63-65`).
- **It can be silently unavailable.** The constructor throws in page context on Chrome for Android,
  which the code already knows and swallows (`run-notifications.tsx:76-88`; the repo's own test
  asserts the thrown string `Use ServiceWorkerRegistration.showNotification() instead.`,
  `run-notifications.test.tsx:164`).

And there is nothing else. Greping `packages/*/src` for `serviceWorker`, `PushManager`, `web-push`
and `nodemailer` returns exactly two hits, both about the *absence* of a ServiceWorker: a comment at
`run-notifications.tsx:78` and the test string above. The runtime dependency budget makes this
structural, not accidental: `@clack/prompts`, `@hono/node-server`, `hono`, `smol-toml`, `ws`, `yaml`,
`zod` (`packages/cezar/package.json:44-51`). Nothing there can send an email or a push, and plan D7
forbids adding anything that could.

Meanwhile the internal event system is rich and already fans out in process:

| Emission | Source | Meaning |
|---|---|---|
| `('run', RunRecord)` | `touch()`, `store.ts:973-976` | every status change, and every other record write |
| `('event', {runId, event})` | `appendEvent()`, `store.ts:711` | every persisted NDJSON line |
| `('event', {runId, event})` | `emitEphemeral()`, `store.ts:861` | coalesced deltas, live wire only |
| `('deleted', id)` | `store.ts:920` | record removal |

The class comment says it outright: `RunStore` is "the in-process event bus the SSE endpoints
subscribe to" (`store.ts:400-405`). So the signal exists, is well shaped, and stops at the edge of
the process. The product ships a mode whose whole promise is that you are not at that process
(`README.md:15-17`: "Leave it on a VPS and you get a dev team that's always on, a mobile-friendly
cockpit you can check from your phone, working your backlog while you're away"), and in that mode
the only way to learn that a run failed at 02:14 is to open the cockpit and look.

## Research

**The seam already exists, and so does a worked precedent for using it.**
`packages/cezar/src/server/provider-auth-runtime.ts` is 82 lines that add a server-side subscriber
to `RunStore` without touching any UI path, any workflow file, or `runs/store.ts` itself. Five
things in it are worth copying rather than reinventing:

1. `store.on('event', onEvent)` and a returned unsubscribe (`:45-46`).
2. A `WeakSet<RunStore>` in an observer class so the same store wired twice yields one listener
   (`:55-68`), which matters because the boot store is wired before recovery and again when the app
   is constructed.
3. Dedupe by reading the run's own log rather than by holding memory (`:31-42`), so a restart does
   not double-fire.
4. A boot-ordering seam that installs observation *before* recovery, because a resumed runner can
   emit before `recover()` returns (`:74-81`).
5. Five wiring call sites, all already written: `server.ts:1228` (boot store), `:1229-1232` (every
   already-peeked context), `:1233` (`contexts.onStoreCreated`), `:1234` (`contexts.onContextBuilt`),
   and `index.ts:397-398` for the headless CLI path.

**The durable-outbox primitives exist too**, in `packages/cezar/src/automations/store.ts`, and they
are the right shape for at-most-once delivery:

- `reserveReceipt()` returns `undefined` on a duplicate key (`:147-165`), which is exactly "one run
  yields at most one `run.failed` ever".
- `acquireLease()` uses `openSync(path, 'wx', 0o600)` with a 10-minute staleness reclaim
  (`:208-227`), which is the cross-process safety two cockpits sharing a `CEZ_HOME` need.
- Every appended row passes `redactDeep(row, this.secrets)` before it touches disk (`:144`, `:176`).
- `compact()` keeps the latest row per key within a retention window plus a log cap (`:192-200`),
  and `maybeCompact()` fires past a row threshold (`:202-206`).
- The retry curve to *diverge* from: `Math.min(6 * 60 * 60_000, 60_000 * 2 ** (failures - 1))` with
  a persisted `backoffUntil` (`packages/cezar/src/automations/scheduler.ts:124-135`). Six hours is
  right for a poller and wrong for a notification, which is worthless long before then.

**Secrets have a stance in this repo already.** `secret-redaction.ts` scrubs credentials out of
persisted events (`:19` the `[REDACTED]` sentinel, `:28-29` `SECRET_NAME_RE`, `:31-42` the
false-positive allow list for `SSH_AUTH_SOCK` and friends). And `server-install` deliberately does
not persist a secret it collects: the ngrok authtoken "is a secret, never stored in server.json; it
lives in ngrok's own config" (`platforms/macosx-ngrok.ts:83`). There is no general secret store, and
this feature must not become one.

**Three signals cezar does not have, and this spec will not pretend it does:**

- `permission.requested` is types-only, RESERVED (`core/ui-events.ts:310-322`), and the attention
  ladder's `hasPendingPermission` returns a hard `false` with a comment explaining that inventing
  data for it would put an unbacked bucket in the UI (`web/src/lib/attention.ts:47-58`).
- Queue depth has no server event; `queuePositions()` is a pure client-side function over the run
  list (`web/src/lib/task-groups.ts:130-135`).
- There is no "the machine went idle" event of any kind.

**One signal cezar does have and that the ASK body can use:** `ask.requested` is a real v2 UiEvent
(`core/ui-events.ts:354-355`), minted from the `CEZ:ASK` marker (`workflows/run.ts:106-109`) on the
same path that parks the run `waiting` (`workflows/run.ts:2209`, `:2794`, `:2948`), and it is
persisted, because the sink's `default` branch writes it to the NDJSON (`runs/ui-event-sink.ts:127-134`).
So a bounded tail read of the run's log can name the question, using the same "read the log" move as
`provider-auth-runtime.ts:31-42`.

**The gates that will judge this feature.** `bc-route-inventory.test.ts` reads a *built* app's route
table and fails unless every route is inventoried in `BACKWARD_COMPATIBILITY.md` section 2
(`:10-40`), so the doc edit is a build gate rather than paperwork. `route-parity.test.ts` compares
three identical GETs byte-for-byte (hence Q13). `typed-bodies.test.ts` catches a route that never
reached `AppType`. `contract-parity.*.test.ts` files exist per domain. Validation is middleware, not
a handler-side parse (`server/validators.ts:88`, `:152`, `:160`; `AGENTS.md:71`). Route families are
chained builders mounted with `.route('/', x)` (`server.ts:5085-5100` for project scope, `:5105-5114`
for workspace scope). `CODE_REVIEW.md:58` lists "secret written to disk" and "server exposed beyond
localhost" as merge blockers, and `SDLC.md:69-71` makes `qa-approved` a hard merge gate for
user-facing work.

## Proposed Solution

One flag, one observer, one decider, one registry, one outbox, one transport kind, N instances.

1. **`CEZ_NOTIFY=1` builds a `NotificationRuntime`; anything else builds nothing.** With the flag
   unset, `server.ts` and `index.ts` skip construction entirely, so there is no listener on any
   `RunStore`, no file under `~/.cezar/notifications/`, no timer, no live handler behind the
   registered route family (which stays inert per plan D19, see Architecture), and no nav item. The
   run path is byte-identical to today.
2. **The observer subscribes to `('run', RunRecord)`** on every store, using the
   `ProviderRuntimeAuthObserver` shape (class, `WeakSet`, five call sites). Its listener body does
   zero I/O beyond one synchronous outbox append, is wholly inside a `try/catch` whose only action
   is a throttled `console.warn`, and awaits nothing. HTTP happens later, on a timer, off the emit
   path.
3. **A pure decider** turns `(previousStatuses, runs, now, config)` into `Notification[]` with every
   noise rule applied. It is a pure function over plain values, so the whole matrix is table-tested
   without a store, a clock or a socket.
4. **A registry of transport instances** routes each notification to the enabled instances whose
   event matrix and project filter admit it. `dispatch()` reserves outbox rows and returns; it never
   awaits a send and never throws.
5. **A durable outbox** (append-only NDJSON under `~/.cezar/notifications/`) plus a demand-driven
   sender: the timer starts when the outbox gains a pending row and is `null` when it drains.
6. **One `webhook` transport**, with an `envelope` or `template` body mode. The template is the
   single design decision that decides fork versus config, and it is specified in Data Models with a
   closed placeholder set.

Three things this deliberately does **not** do. It does not touch the existing browser toggle at
`WorkspaceUiState.notifications` (`packages/contract/src/workspace.ts:216`), because "this browser
delivers" and "this machine delivers" are different questions and one switch must not mean two
things. It does not add a runtime dependency (plan D7). And it writes nothing into any project
directory, so nothing needs adding to `ensureDataGitignore`'s `wanted` list
(`packages/cezar/src/index.ts:664-683`) and no PII can reach a git remote (plan D9): every file this
feature creates lives under `cezarHomeDir()` (`packages/cezar/src/paths.ts:16`) and passes
`assertCezarHomeWriteIsSandboxed` (`:36`).

## The upstream / fork split

**100% of the code is upstreamable. 0% of it names Loki.**

| Layer | Where it lives | Upstreamable |
|---|---|---|
| Transport interface, registry, decider, outbox, sender, retry, rate limit, quiet hours, routes, CLI, Settings pane, testkit | `packages/cezar/src/notifications/**`, `packages/contract/src/notifications.ts`, `packages/web/src/routes/settings/notifications-section.tsx` | **Yes, the whole PR** |
| The `webhook` transport (URL, method, header map, auth reference, JSON body template) | `packages/cezar/src/notifications/transports/webhook.ts` | **Yes.** ntfy, Slack, Discord, Gotify, Matrix, Apprise and a home-grown endpoint are all this one transport with different config |
| Loki Messages, every channel | **one row** (`id: "loki"`) in `~/.cezar/notifications.json` plus one env var on the VPS plus one recipe doc | **Not code at all.** Config only, no fork |

The single decision that decides fork versus config is the **body template**. A generic
`{title, body, url}` envelope covers ntfy and Slack and does not cover a real notification ingress:
SPEC-417's route wants `{"event":…,"title":…,"body":…,"deepLink":…,"dedupeKey":…,"transports":[…]}`,
with `dedupeKey` required and `transports` naming the channels to fan out to. Hardcoding that URL,
header name or body shape anywhere in `src/` is precisely what would force a permanent fork of a file
upstream churns. So `webhook.payload` is `'envelope' | 'template'`, and `template` is a JSON document
with a **closed** placeholder set, JSON-escaped at substitution (see Data Models). The `transports`
array is a plain JSON literal inside that template, needing no placeholder, no loop and no
conditional, which is why one row can carry a per-channel enable list without the template becoming a
language.

The acceptance criterion that proves it, on W2.4: a send to a SPEC-417-shaped ingress is driven
**from JSON config alone**, asserting the exact outgoing request (URL, bearer header, and a body
carrying `dedupeKey` and `transports`), and a companion grep asserts the strings `loki`,
`lokimessages` and `imsg` appear nowhere under `packages/cezar/src/` or `packages/contract/src/`. A
test that only did the first half would pass with a hardcoded vendor branch in the transport.

## Architecture

### Runtime construction, and what "off" means mechanically

`CEZ_NOTIFY === '1'` is read once at construction. When it does not hold, `createNotificationRuntime()`
returns `undefined` and every call site is a no-op guard, so:

- no `store.on(...)` call is made on any `RunStore`;
- `loadNotificationsConfig()` is never called, so `~/.cezar/notifications.json` is not even stat'd;
- no directory is created under `~/.cezar/notifications/`;
- no interval or socket exists;
- the route family is registered but inert, in the scaffold's one shape (plan D19): every `GET`
  answers **200 with an empty payload** (`{configured: false, transports: [], events: [], ...}` with
  its arrays empty), and every mutator (`PUT`, `POST`, `DELETE`, `/test`, `/log/:rowId/retry`)
  answers **409** with the standard `{error}` body. **Never 404.** The feature is switched off, not
  missing; a 404 additionally tells the typed client the route does not exist, which contradicts the
  contract that same client is generated from. W1.1 builds all five inert route families in one
  commit and cannot implement two shapes, so this is the shape.

This keeps `AppType` and the BC inventory stable in both states, which is what keeps `typed-bodies`
and `bc-route-inventory` from flapping on the flag.

The plan's own honesty check applies here: with every flag unset, `/api/v1/health` and the agent
system prompt must be **byte-identical** to the pre-change build.

### The observer (W4.5), off the run's critical path

`packages/cezar/src/notifications/observer.ts` exports `watchRunNotifications(store, sink)` returning
an unsubscribe, plus a `RunNotificationObserver` class holding a `WeakSet<RunStore>`, mirroring
`provider-auth-runtime.ts:55-68`. It subscribes to `('run', RunRecord)` for transitions, and to
`('event', ...)` for exactly one type, `provider-auth-required`, which the existing observer already
appends (`provider-auth-runtime.ts:36-41`).

Four properties make "a notification failure can never fail or block a run" structural rather than
careful:

1. The listener body is entirely inside `try/catch` whose only action is one throttled `console.warn`
   (at most one per transport per hour).
2. It performs zero I/O beyond one synchronous outbox append. Every HTTP call happens on the sender
   timer.
3. Every outbound `fetch` carries `AbortSignal.timeout(...)`, so a hanging endpoint cannot pin a
   socket forever.
4. There is no `await` of anything notification-shaped in `packages/cezar/src/workflows/run.ts` or
   `packages/cezar/src/runs/store.ts`. The entire seam is one `store.on(...)`, and a grep asserts it.

### The decider (W1.7), pure

`decide(previous, runs, now, config) -> Notification[]`. Pure over plain values: no store, no clock,
no fs. It owns the two silences ported verbatim from the browser (`notifications.ts:86-91`): a run
seen for the first time never notifies, and an unchanged status never notifies. It owns the boot
grace, coalescing, quiet hours and the token bucket described under Noise control.

It also owns **the one mapping table**. `decider.ts` is the only file under `src/notifications/`
permitted to contain a bare `RunStatus` string literal, and `wantsAttention` is not imported
anywhere in the directory. Both are asserted by a test, because the failure mode this prevents (the
dot and the notification quietly stop agreeing about what "needs you" means) is invisible until a
user reports it.

### The registry (W1.7)

Holds instances, not types. `routeFor(event, projectId)` returns the enabled transports whose event
matrix and project filter admit this event. `dispatch(notification)` reserves outbox rows and
returns `void`. The registry wraps every transport call, because a transport is third-party-shaped
code: a synchronous throw, a rejected promise and a hang are all coerced to
`{ok: false, retryable: true}`.

### Config and secrets (W1.8)

`~/.cezar/notifications.json` follows the `agent-accounts.json` house rules exactly
(`workspace/agent-accounts.ts:27-33`): every field optional with `.catch`, `z.looseObject` at every
level, **per-entry salvage for `transports[]`** so one hand-edited row never evicts the rest, writes
through a merge-write that resolves its path once with atomic tmp plus rename at mode `0600` (dir
`0700`), and a corrupt file degrading to in-memory defaults with one warning while being **left on
disk untouched**. Missing file means `{version: 1, transports: []}` with nothing created.

`resolveAuth()` reads `authEnvVar` from `process.env` at send time and returns a value that is never
persisted. `describeAuth()` returns only `{source, envVar, present}` or `{source: 'inline', present,
hint}`, where the hint is the last four characters and only at length >= 12. A webhook URL carrying
userinfo (`https://user:pass@host/...`) is rejected at parse with a named error and never stored,
because a credential in a URL is a credential in every log line that URL appears in.

### Outbox and sender (W2.5)

`~/.cezar/notifications/outbox.ndjson`, append-only, one row per (notification x transport), reserved
through the `reserveReceipt` collision pattern (`automations/store.ts:147-165`) keyed on
`(transportId, dedupeKey)`. Reserve happens before send, so a crash leaves a `reserved` row rather
than a lost one.

- **Restart recovery.** Rows still `reserved` or `sending` past a 10-minute lease staleness are
  re-queued exactly **once**, subject to the staleness ceiling.
- **Cross-process lease.** `~/.cezar/notifications/outbox.lock` via `openSync(path, 'wx', 0o600)` with
  10-minute staleness reclaim, the `automations/store.ts:208-227` primitive verbatim, so two cockpits
  sharing a `CEZ_HOME` never double-send.
- **Retry.** `delay = min(15min, 2000 * 2^(attempt-1)) * (0.5 + random())`, max 6 attempts. Capped
  tighter than the automations six-hour curve (`automations/scheduler.ts:127`) on purpose: a stale
  notification is worthless, and the staleness ceiling would drop it anyway. An HTTP `Retry-After`
  or a transport-supplied `retryAfterMs` overrides.
- **Circuit breaker.** Five consecutive hard failures set `backoffUntil` and flip the transport to
  `degraded`; `healthcheck()` probes for recovery. `health.status` is a persisted enum **written by
  that transition**, never recomputed at read time from `backoffUntil` against the clock (Q13, plan
  D8 and D20: naming a field stored does not make it stored). Persisted in
  `~/.cezar/notifications/state.json`, atomic tmp plus rename `0600`, the same shape
  `automations/store.ts` uses for automation state.
- **Demand-driven.** The sender interval starts on the first pending row and is `null` after the
  outbox drains, following the `health` topic publisher's start/stop discipline
  (`server.ts:1593-1611`). An idle cezar with configured transports runs no notification timer.
- **Retention.** `compact()` keeps the latest row per `(transportId, dedupeKey)` within a 7-day
  window plus the last 5,000 log rows; `maybeCompact()` fires past 20,000 rows. The
  `automations/store.ts:192-206` shape.

### Observability

The plan's critic recorded that all three designs shipped zero telemetry, and that this workspace's
recorded failure mode is a silent no-op that ran for roughly 45 consecutive ticks. So the outbox is
the telemetry: every decision that removes a message leaves a row. `dropped` carries a
`droppedReason` of `stale`, `rate`, `quiet-expired` or `transport-removed`; a suppressed batch emits
one "N notifications suppressed" summary when the bucket refills; a reclaimed lease and a re-queued
row are log rows. In-process counters (`sent`, `failed`, `dropped`, `suppressed`, `leaseReclaimed`,
`requeued`) ride the transport health object on the GET. Nothing here is clock-derived (Q13): a
counter and a stored timestamp are both stable between two identical GETs.

### Wiring, and who owns which file

The observer body is W4.5's; the **wiring is not**. `server.ts`, `packages/cezar/src/index.ts`,
`.env.example`, `README.md` and `BACKWARD_COMPATIBILITY.md` are all owned by the plan's W1.1
scaffold (plan D6: one solo package owns every shared file, once). W4.5 therefore hands the scaffold
a constructor and five one-line call sites, and W3.1 makes the workspace-level runtime reachable from
`project-context.ts`. A notifications package that edits `server.ts` is a plan violation, and per
dispatch-contract rule 5 the correct move is to stop and hand back.

This also resolves the `.env.example` trap the critic named (`AGENTS.md:19`: "an undocumented env var
is a bug"): the scaffold introduces the flag *and* documents it in the same commit, so no package in
this feature ever ships an env var whose documentation lands later.

## Event to notification mapping

Derived from what cezar actually emits. `RunStatus` is
`queued | running | waiting | review | done | failed | cancelled`
(`packages/contract/src/runs.ts:28-37`).

| Event id | Fired by | Severity | Default | Notes |
|---|---|---|---|---|
| `run.failed` | `status -> failed` **and no** `autoResumeAt` | urgent | **on** | The plain failure. |
| `run.needs-you` | `status -> waiting` | urgent | **on** | The ASK signal. Body carries the first question, read by a bounded tail scan of the run's NDJSON for the last `ask.requested` (`core/ui-events.ts:354-355`, persisted via `runs/ui-event-sink.ts:127-134`), capped so a huge transcript cannot stall the append path. |
| `run.review` | `status -> review` | warn | **on** | Body appends `pullRequestUrl` when the janitor found one. |
| `run.finished` | `status -> done` | info | **on** | The primary coalescing target. |
| `run.usage-limit` | `status -> failed` **with** `autoResumeAt` | info | **on** | Names the resume instant from `autoResumeAt` (`packages/contract/src/runs.ts:190-192`, shipped by `.ai/specs/2026-08-03-auto-resume-after-usage-limit.md`). Never also `run.failed`. |
| `provider.auth-required` | the `provider-auth-required` store event | urgent | **on** | Deep-links to the accounts settings. On a box nobody watches, an expired credential silently fails every subsequent run. |
| `queue.drained` | derived: active count `>=1 -> 0` **and** at least one run finished in the window | info | **off** | See Q8. No server event exists behind it. |
| `test` | the test button or `cez notify test <id>` | info | n/a | Never deduped, rate-limited or quiet-hours-suppressed: a human pressed it. |

**Deliberately not notify-worthy**, and each for a reason a later reader can check:

- **`activity: 'monitoring'`** (a sub-state of `running`, `packages/contract/src/runs.ts:44`) fires
  nothing, ever. Already decided and tested at
  `.ai/specs/2026-07-18-subagent-monitoring-status.md:214-215`.
- **`status -> running`** and **`status -> queued`**. A task starting is not news to the person who
  started it, and on a box with `maxParallel` slots recycling it is the highest-frequency transition
  there is.
- **`status -> cancelled`**. A human cancelled it; telling them so is a receipt, not a signal.
- **Any `('event', ...)` type other than `provider-auth-required`.** Per Q5, per-step traffic can
  never mint a notification.
- **Permission prompts.** Nothing emits them (Q7).
- **Record writes that are not status changes.** `touch()` fires on every record write
  (`store.ts:973-976`), including title auto-naming and `seenAt` receipts, so the decider compares
  the previous *status* rather than reacting to the emission.

## Noise control

This is the section that decides whether the feature is usable at all. A notifier that pages
correctly and pages constantly is worse than no notifier, because the user mutes the transport and
then the urgent one does not arrive either.

1. **One message per task, never per step.** Structural (Q5): only `('run', ...)` transitions can
   mint anything, and the dedupe key is `${projectId}:${runId}:${event}`, reserved in the durable
   outbox, so a given run yields at most one `run.failed` **ever**, across restarts. This is the
   owner's existing rule made mechanical: the workspace's reporter notifier groups by conversation
   and sends one consolidated message rather than one ping per item, and treats a re-run that sends
   zero as the healthy case rather than a failure. Same shape here.
2. **Coalescing.** `coalesceMs` default 20,000 (urgent events use `urgentCoalesceMs`, default 5,000).
   Notifications entering the window with the same `(transportId, projectId, severityClass)` merge
   into one message listing up to five named runs then "and N more". Batches never mix projects, so
   the recipient reads the repo name once. This is the "twelve parallel runs land at 02:14" case, and
   it is reachable: `maxParallel` is workspace-wide with a per-project override of 1 to 16
   (`BACKWARD_COMPATIBILITY.md:30`), so three busy projects can retire dozens of runs inside one
   window.
3. **Per-event rate limits.** A token bucket per transport instance: default 10 per hour, burst 4,
   hard ceiling 2 per minute. Over budget folds into the next window and is **never silently
   dropped**; if the batch is still over budget when the bucket refills, one "N notifications
   suppressed" summary goes out and every suppressed row stays visible in the log.
4. **Quiet hours.** `{start: "22:00", end: "07:00", timezone?}` (IANA, defaulting to the host zone),
   per-transport overridable. Only `severity: 'urgent'` passes, and only when `quietHoursAllowUrgent`
   (default true). Everything else queues and lands as one digest when the window ends. The DST case
   is tested, because a 22:00 to 07:00 window must not become a 25-hour silence.
5. **Dedupe keys, durable.** `${projectId}:${runId}:${event}` for run events;
   `${projectId}:provider:${provider}:${authFailureId}` for auth (the same identity
   `provider-auth-runtime.ts:31-34` dedupes on); `test:${uuid}` for the test button, which therefore
   never collides and is never deduped.
6. **No replay storm on restart.** Three layers, because a server restart has none of the browser's
   in-memory protection: a boot grace (`BOOT_GRACE_MS`, 10 s) during which transitions are *recorded*
   but not *sent* while recovery re-materialises statuses; the "first sight never notifies" rule
   ported from `notifications.ts:86-91`; and the staleness ceiling below.
7. **Staleness ceiling.** A queued notification older than `maxAgeMs` (default 6 h) closes as
   `dropped: 'stale'` rather than being delivered. Nobody wants a 03:00 page at 09:00 about a task
   that has since been fixed. It stays in the log, so "dropped" is never silent.

## Data Models

### 1. `~/.cezar/notifications.json` (config, its own file)

```jsonc
{
  "version": 1,
  "defaults": {
    "coalesceMs": 20000,          // 0..300000
    "urgentCoalesceMs": 5000,
    "maxAgeMs": 21600000,         // staleness ceiling, 6h
    "cockpitUrl": null,           // null = discover (server-install domain, else loopback)
    "quietHours": null,           // {start:"22:00", end:"07:00", timezone?:"Europe/Warsaw"}
    "quietHoursAllowUrgent": true,
    "rate": { "perHour": 10, "burst": 4, "perMinute": 2 }
  },
  "transports": [
    {
      "id": "loki",               // ^[a-z0-9][a-z0-9-]{0,31}$. ONE row per endpoint, not per channel
      "kind": "webhook",          // the only kind in v1
      "label": "Loki Messages",
      "enabled": true,
      "events": {                 // per-event opt-in; an absent key means the event's default
        "run.failed": true, "run.needs-you": true, "run.review": true,
        "run.finished": true, "run.usage-limit": true,
        "provider.auth-required": true, "queue.drained": false
      },
      "projects": null,           // null = all; or ["myrepo","other"] project ids
      "quietHours": null,         // per-transport override of defaults
      "rate": null,
      // idempotencyKey MUST be true whenever the template renders {{dedupeKey}}: this endpoint
      // requires it, and a transport that claims not to carry one would let the sender skip it.
      "capabilities": { "maxTitleChars": 80, "maxBodyChars": 1200, "links": "inline",
                        "markdown": false, "batch": true, "idempotencyKey": true },
      "webhook": {
        "url": "https://auth.example.com/notify/v1/events",
        "method": "POST",
        "headers": { "content-type": "application/json" },
        "auth": { "scheme": "bearer", "header": "authorization",
                  "envVar": "CEZ_NOTIFY_TOKEN" },            // XOR "inline": "..."
        "payload": "template",     // "envelope" | "template"
        // "transports" is a literal array, NOT a placeholder: it is the per-channel enable list,
        // and editing it is how a channel is turned on or off. 202 is a real answer here
        // ("accepted, nothing delivered"), so it belongs in successStatuses.
        "template": "{\"event\":\"{{event}}\",\"title\":\"{{title}}\",\"body\":\"{{body}}\",\"deepLink\":\"{{url}}\",\"dedupeKey\":\"{{dedupeKey}}\",\"transports\":[\"imessage\"]}",
        "timeoutMs": 10000,
        "successStatuses": [200, 202]
      }
    }
  ]
}
```

**The template contract, stated precisely, because it is the fork-versus-config decision.**

- **Closed placeholder set, no expressions, no loops, no conditionals:**
  `{{title}}`, `{{body}}`, `{{text}}`, `{{url}}`, `{{event}}`, `{{severity}}`, `{{project}}`,
  `{{count}}`, `{{runId}}`, `{{dedupeKey}}`. An unknown `{{...}}` is a parse error at load, not an
  empty string at send, so a typo surfaces as `unconfigured` in the UI rather than as a malformed 400
  at 02:14.
- `{{text}}` is `title + "\n" + body + "\n" + url`, pre-truncated to `capabilities.maxBodyChars`.
- `{{dedupeKey}}` is the row's own outbox key (`${projectId}:${runId}:${event}` for run events, see
  Noise control), rendered so the **receiver** can be idempotent too. cezar's `reserve()` collision
  check only bounds what cezar sends; a retry after a timeout, a 5xx, or a reclaimed lease is a
  second HTTP request carrying the same notification, and without a per-item key on the wire the
  receiving end has no way to tell that from a second notification. Passing it is what makes a retry
  cost nothing instead of double-messaging a phone at 02:14. Any endpoint that requires such a key,
  SPEC-417's ingress among them, is therefore configurable with no code change, and a transport whose
  template renders it must declare `capabilities.idempotencyKey: true`.
- **Every substitution is JSON-string-escaped** at the point of substitution. A run title containing
  a quote, a brace, a backslash or a newline must land as one JSON string value and must not be able
  to close the string, add a sibling key, or change the request shape.
- After substitution the result must `JSON.parse`. If it does not, the transport loads as
  `unconfigured` with a named error at config-load time. A template is validated once when it is
  written, not discovered broken when something urgent needs sending.

`webhook.url` is rejected at parse when it carries userinfo. The documentation says put the
credential in a header, never in the query string, for the same reason.

### 2. `~/.cezar/notifications/outbox.ndjson` (durable outbox, append-only)

```ts
const outboxRowSchema = z.object({
  seq: z.number().int(),
  rowId: z.string(),                 // uuid
  transportId: z.string(),
  dedupeKey: z.string(),             // (transportId, dedupeKey) is the at-most-once key
  event: notificationEventSchema,
  severity: z.enum(['info','warn','urgent']),
  projectId: z.string(),
  runIds: z.array(z.string()).max(50),
  title: z.string().max(200),
  body: z.string().max(2000),
  url: z.string().optional(),
  status: z.enum(['reserved','sending','sent','failed','dropped']),
  attempts: z.number().int().default(0),
  nextAttemptAt: z.string().optional(),
  lastError: z.string().max(500).optional(),   // redacted
  httpStatus: z.number().int().optional(),
  droppedReason: z.enum(['stale','rate','quiet-expired','transport-removed']).optional(),
  // host + path only, header NAMES only, never values and never an interpolated body
  request: z.object({ url: z.string(), headerNames: z.array(z.string()) }).optional(),
  createdAt: z.string(), updatedAt: z.string(),
});
```

Every row passes `redactDeep(row, collectSecretValues())` before append, exactly as
`automations/store.ts:144` does. Siblings: `outbox.lock` (the `wx` lease) and `state.json`
(per-transport `{consecutiveFailures, backoffUntil, lastSuccessAt, lastAttemptAt, counters,
bucket:{tokens, refilledAt}}`).

### 3. In-memory types (`packages/cezar/src/notifications/types.ts`)

```ts
export type NotificationEvent =
  | 'run.failed' | 'run.needs-you' | 'run.review' | 'run.finished'
  | 'run.usage-limit' | 'provider.auth-required' | 'queue.drained' | 'test';

export type Severity = 'info' | 'warn' | 'urgent';

export interface TransportCapabilities {
  maxTitleChars: number;
  maxBodyChars: number;
  /** How a deep link is carried: its own field, appended to the body, or dropped. */
  links: 'field' | 'inline' | 'none';
  markdown: boolean;
  batch: boolean;
  idempotencyKey: boolean;
}

export type DeliveryResult =
  | { ok: true; providerId?: string; httpStatus?: number; durationMs: number }
  | { ok: false; retryable: boolean; error: string; httpStatus?: number;
      retryAfterMs?: number; durationMs: number };

export interface NotificationTransport {
  readonly id: string;
  readonly kind: 'webhook';
  readonly capabilities: TransportCapabilities;
  /** MUST NOT throw. Every failure is a DeliveryResult. The registry wraps it
   *  anyway (throw, rejection and hang all coerce to {ok:false, retryable:true}),
   *  because a transport is third-party-shaped code and a run must never see it. */
  send(notification: Notification, signal: AbortSignal): Promise<DeliveryResult>;
  healthcheck(signal: AbortSignal): Promise<HealthResult>;
}
```

### 4. Contract additions (`packages/contract/src/notifications.ts`, scaffold-owned)

One zod definition per wire shape with its type inferred, never a hand-written interface. Optional
keys are **spread conditionally**, never typed `key: T | undefined`, which is the exact drift
`contract-parity` catches. Object-literal discriminants get `as const`. `transportViewSchema` is the
redacted read shape and **structurally cannot carry a secret or a full URL**: it has `endpointHost`
plus `endpointPath` and an `auth` union of `{source:'env', envVar, present}` or
`{source:'inline', present, hint}` or `{source:'none'}`.

## API Contracts

All routes are **workspace-level and single-mount**, never mirrored under `/api/v1/p/:projectId/`,
because they answer for the whole machine exactly like `/api/v1/workspace/config`. They are
registered as one **chained** family and `.route('/', notificationsRoutes)`-ed into the workspace
chain beside `workspaceConfigRoutes` (`server.ts:5111`). A loose `app.get(...)` or an annotated
return type would drop them from `AppType` while the server kept serving them, which is what
`typed-bodies.test.ts` exists to catch. Bodies, params and query validate as **middleware** through
`jsonZodValidator` / `paramZodValidator` / `queryZodValidator` (`server/validators.ts:88`, `:152`,
`:160`).

```
GET    /api/v1/workspace/notifications
  -> { configured: boolean,
       cockpitUrl: { value: string, source: 'config'|'server-install'|'loopback' },
       defaults: { coalesceMs, urgentCoalesceMs, maxAgeMs, quietHours, quietHoursAllowUrgent, rate },
       events: [{ id, label, severity, defaultEnabled }],   // the mapping table, for the matrix UI
       transports: [{
         id, kind, label, enabled,
         endpointHost, endpointPath,            // the full URL is WRITE-ONLY
         auth: { source:'env', envVar, present } | { source:'inline', present, hint } | { source:'none' },
         events, projects, quietHours, rate, capabilities,
         health: { status:'ok'|'degraded'|'unconfigured'|'disabled',
                   lastAttemptAt?, lastSuccessAt?, lastError?, consecutiveFailures,
                   backoffUntil?, counters }
       }] }

PUT    /api/v1/workspace/notifications                       // partial merge of `defaults` only
POST   /api/v1/workspace/notifications/transports            -> { transport }   409 duplicate id
PUT    /api/v1/workspace/notifications/transports/:id        -> { transport }   404 unknown
DELETE /api/v1/workspace/notifications/transports/:id        -> { deleted: true }  (idempotent)
POST   /api/v1/workspace/notifications/transports/:id/test   -> { delivered, httpStatus?, error?, durationMs }
GET    /api/v1/workspace/notifications/log?cursor=&limit=&transportId=&status=
                                                             -> { rows, nextCursor? }
POST   /api/v1/workspace/notifications/log/:rowId/retry      -> { requeued: boolean }
```

Shapes mirror the automations family (`GET /api/v1/automation-log` at `server.ts:3377`,
`POST /api/v1/automation-log/:receiptId/retry` at `:3381`): same cursor pagination, the same `limit`
cap of 100 (`automations/store.ts:180`), the same `{error}` rejection shape with 400 / 404 / 409.

**No clock-derived field appears in any GET body** (Q13, plan D8). `health` carries stored instants
and stored counters only.

**Write-only fields.** `webhook.url` and `auth.inline` are accepted on POST and PUT and never
returned. A PUT that omits `auth` leaves the stored credential alone; a PUT with
`auth.inline === "__unchanged__"` does the same explicitly, so a UI round-trip cannot blank a secret
it was never shown.

**`/test` is the exception path.** It bypasses dedupe, coalescing, quiet hours and the rate bucket
(a human pressed a button) and returns the verbatim `DeliveryResult` including HTTP status and error
text. It is the one place a raw upstream error string is surfaced, because that is exactly what a
person debugging a webhook needs, and it is still passed through the redactor first.

**WebSocket.** A demand-driven topic `notifications` on the existing bus, registered with
`{ loopbackReadable: false }` (`server/ws.ts:95`, and the `health` topic's `true` at
`server.ts:1611` is the deliberate exception it must not copy), because this payload carries endpoint
hostnames and error strings. Its publisher starts at 0 to 1 subscribers, publishes only on change,
and stops at 1 to 0. Subscribed in the Settings view, not at the root.

**CLI** (registered by the scaffold in `packages/cezar/src/index.ts`, body owned by W4.7):

```
cez notify list
cez notify add <id> --url <u> [--auth-env VAR | --auth-inline] [--events a,b,c] [--label L]
cez notify set <id> [--url ...] [--events ...] [--quiet 22:00-07:00] [--rate 10/h]
cez notify enable <id> | disable <id> | rm <id>
cez notify test <id>          # exit 0 on delivered, 1 otherwise, so a VPS can script it
cez notify log [--limit N] [--transport id]
```

**Env vars** (all optional, all inert when unset, all documented in `.env.example` by the scaffold in
the same commit that introduces them, per `AGENTS.md:19`):

```
CEZ_NOTIFY=1                # the ONLY switch. Exact string. Unset = the feature does not exist
CEZ_NOTIFY_WEBHOOK_URL      # single-transport bootstrap for containers
CEZ_NOTIFY_WEBHOOK_TOKEN    # matches SECRET_NAME_RE, so it is auto-scrubbed from transcripts
CEZ_NOTIFY_<ID>_TOKEN       # per-transport credential referenced by auth.envVar
CEZ_NOTIFY_TOKEN            # the same mechanism, the name SPEC-417 pins for the single `loki` row
CEZ_COCKPIT_URL             # override the discovered deep-link base
```

**Backward compatibility.** The scaffold inventories every route above in
`BACKWARD_COMPATIBILITY.md` section 2 (otherwise `bc-route-inventory.test.ts` is red, `:10-40`),
lists the CLI subcommand and env vars in section 1, and records the two new `~/.cezar` files in
section 9 alongside `agent-accounts.json` (`:148-153`) with the same contract: own file, passthrough,
per-entry salvage, `0600`, merge-write, written-never-required.

## Configuration on a headless VPS

Three paths, none of which needs a browser, because the deployment this feature exists for has no
browser on it:

1. **CLI**: `cez notify add ... && cez notify test <id>`, which exits non-zero on failure so it can
   gate a provisioning script.
2. **The JSON file**, dropped in place at `0600`. Documented shape, no tooling required.
3. **Env bootstrap** for the container case: `CEZ_NOTIFY=1` plus `CEZ_NOTIFY_WEBHOOK_URL` plus
   `CEZ_NOTIFY_WEBHOOK_TOKEN` synthesise exactly one enabled `webhook` transport with the default
   event matrix and write no file. Unset yields nothing.

The credential never lands in the config file on any of these paths. It stays in the process
environment, under a name that `SECRET_NAME_RE` already recognises
(`core/secret-redaction.ts:28-29`), which means the redactor scrubs its *value* out of every
persisted run event for free.

### The Loki Messages recipe, config only, zero cezar code

**One row, not one per channel** (plan D23). The endpoint fans out server-side, so cezar names the
channels in the body instead of opening a second connection to the same address.

```bash
export CEZ_NOTIFY=1
export CEZ_NOTIFY_TOKEN='lok_...'          # scope='notify' key; matches SECRET_NAME_RE, so it is scrubbed
cez notify add loki \
  --url https://auth.lokimessages.com/notify/v1/events \
  --auth-env CEZ_NOTIFY_TOKEN \
  --template '{"event":"{{event}}","title":"{{title}}","body":"{{body}}","deepLink":"{{url}}","dedupeKey":"{{dedupeKey}}","transports":["imessage"]}'
cez notify test loki
```

`auth.envVar` names any variable; the documented default spelling is `CEZ_NOTIFY_<ID>_TOKEN`, and
SPEC-417 pins `CEZ_NOTIFY_TOKEN` for this row specifically. The key carries `scope = 'notify'` and is
accepted **only** by `/notify/v1/events`; SPEC-417 makes it a negative control that the same key must
401 anywhere else, so this row cannot be repointed at a general messaging route.

Telegram and WhatsApp are admitted the same way, by adding `"telegram"` or `"whatsapp"` to that one
array (`cez notify set loki --template ...`), which is the whole cezar-side gesture: one row, one
edit, one dedupe key per notification. All three channels go through the same ingress on the same
key, so a channel costs cezar nothing but a legal string (Q2, plan D12). It is not the whole story,
and the spec says so rather than letting a user discover it: the channel also has to be enabled and
enrolled on the receiving side (SPEC-417 P4.8), and for WhatsApp the receiver additionally answers
`window_closed` once the 24-hour session window has lapsed. Until those hold, the array entry admits
a channel that delivers nothing and says which of those it was, per channel, in the result array.
A non-Loki target such as ntfy or Slack is still a second `cez notify add`, because the generic seam
is unchanged and remains N instances. Nothing in `packages/` changes for any of them.

## Cost arithmetic

**Message volume from a busy cockpit, uncoalesced.** Each completed run contributes one terminal
notification plus roughly one `run.needs-you` per ask, so notify-worthy transitions per run land
around 1 to 3. Throughput is `slots * 60 / T` runs per hour for a mean task wall clock of `T`
minutes. At the workspace default `maxParallel: 2` (`workspace/semaphore.ts:110`) and `T = 20`, that
is 6 runs per hour, so roughly 6 to 18 notifications per hour. At the per-project ceiling of 16
(`BACKWARD_COMPATIBILITY.md:30`) across three registered projects with `T = 20`, it is 144 runs per
hour, so roughly **144 to 432 notifications per hour**, and the burst shape is worse than the mean:
runs started together finish together, so dozens can land inside one second.

**With noise control, the ceiling is a constant.** The token bucket is 10 per hour per transport with
a hard 2 per minute, so a configured transport emits at most **240 messages per day regardless of run
volume**. That is the real argument, and it is exact by construction rather than estimated: noise
control converts an unbounded, run-volume-proportional message count into a bounded, config-declared
one. Coalescing is what makes the bounded number *informative* instead of arbitrary, because 48 runs
finishing together become one message per project rather than 10 arbitrary ones plus 38 suppressions.

**Is noise control a cost requirement or only a UX one? Both, and the binding constraint is not
dollars.**

- **Storage.** An outbox row is roughly 300 to 600 bytes at typical title and body lengths. At the
  uncoalesced 432 per hour figure that is about 10,400 rows and roughly 4 MB per day, which crosses
  the 20,000-row `maybeCompact()` threshold about twice a day. With the bucket in place it is 240
  rows and under 150 kB per day, and compaction is a background nicety rather than the thing standing
  between the user and an unbounded file in their home directory.
- **Provider quotas, which are the actual wall.** Telegram's Bot API allows roughly 1 message per
  second per chat and about 30 per second globally, and cezar enforces neither, so the notifier must.
  Apple flags a burst from one Apple ID as spam, and the Loki iMessage path paces bubbles by 400 to
  800 ms because of it. WhatsApp gates volume behind Meta business verification tiers. A notifier
  without a rate limit does not fail with a bill; it fails by getting the sending account throttled
  or flagged, which takes every future notification down with it.
- **Money.** Per notification the cezar side costs one outbound HTTPS request and one NDJSON append.
  On the receiving side an iMessage send is roughly two small D1 row writes; at the bounded 240 per
  day that is about 15,000 row writes per month, which is not a meaningful line on a bill dominated
  by D1 writes. Stating that plainly matters: **do not justify noise control on cloud spend, because
  the spend argument is weak and a reader who checks it will discount the whole section.**
- **The human cost, which is why the feature lives or dies here.** A phone that buzzes 400 times in
  an hour gets the transport muted, and a muted transport delivers nothing. The one signal this
  feature exists to deliver, "your run is parked waiting for you on a box you are not sitting at",
  is precisely the one lost first.

## Phases (PLAN work packages)

Only W1.7, W1.8, W2.4, W2.5, W4.5, W4.7 and W4.9 belong to this feature. The shared-file work
(contract domain, inert route family, `server.ts` and `index.ts` wiring, `.env.example`,
`README.md`, `BACKWARD_COMPATIBILITY.md`, web nav / routes / api client / settings registry) is
**W1.1 SCAFFOLD (SOLO)** and is not touched here (plan D6).

| Package | Owns (exact) | Deps | Acceptance |
|---|---|---|---|
| **W1.7** Notifier core | `packages/cezar/src/notifications/{types,registry,decider}.ts` + tests | W1.1 | `decide()` is pure and table-tested: first sight silent, unchanged status silent, `activity==='monitoring'` silent, `failed` **with** `autoResumeAt` yields `run.usage-limit` and never `run.failed`, boot grace records without sending. Coalescing merges same `(transportId, projectId, severityClass)` into one message listing five runs then "and N more"; batches never mix projects. Quiet hours pass only `urgent`, with a DST case. The token bucket folds over-budget into the next window and emits one suppression summary. The **one mapping table** lives in `decider.ts`; a test asserts no bare `RunStatus` literal appears elsewhere under `src/notifications/` and that `wantsAttention` is imported nowhere in the directory. `registry.dispatch()` never awaits and never throws. The event enum contains no `permission.*` member. |
| **W1.8** Config, secrets, env bootstrap | `packages/cezar/src/notifications/{config,secrets}.ts` + tests | W1.1 | Missing file yields `{version:1, transports:[]}` with no file created and no warning. Corrupt file yields in-memory defaults, ONE warning, file left on disk. Read-only home never fails boot. Per-entry salvage proven: one malformed row in `transports[]` keeps the rest. Writes resolve their path once, tmp plus rename, `0600` (dir `0700`), through `assertCezarHomeWriteIsSandboxed`. A URL with userinfo is rejected at parse with a named error and never stored. `describeAuth()` returns only `{source, envVar, present}` or a last-4 hint at length >= 12. Env bootstrap synthesises exactly one transport when both vars are present, and nothing when either is absent. |
| **W2.4** Webhook transport, templating, testkit | `packages/cezar/src/notifications/transports/webhook.ts`, `packages/cezar/src/notifications/testkit.ts` + tests | W1.7 | `fetch` is an injected dependency; no test performs a real network call. `send()` never throws: timeouts, DNS failures, non-2xx and malformed responses all return a `DeliveryResult`; 4xx except 408 and 429 is `retryable:false`, 5xx / 408 / 429 / network is `retryable:true` and reads `Retry-After`. Closed placeholder set including `{{dedupeKey}}`, JSON-escaped substitution, unknown placeholder is a load-time error, and a template that fails `JSON.parse` after substitution loads `unconfigured` with a named error. **The upstream acceptance**: a single transport row built from JSON alone, pointed at a SPEC-417-shaped ingress (`POST /notify/v1/events`, bearer `lok_*` of scope `notify`), produces the exact expected request, asserted byte-for-byte, with the body carrying `event`, `title`, `body`, `deepLink`, the required `dedupeKey`, and a literal `transports` array; a second case adds `"telegram"` to that array and asserts the request changes in exactly that one field, proving per-channel enablement is config; AND a grep asserts `loki`, `lokimessages` and `imsg` appear nowhere under `packages/cezar/src/` or `packages/contract/src/`. Neither half counts alone: the grep passes on a build that cannot do the send, and the send test passes on a hardcoded vendor branch. `testkit.ts` exports `recordingTransport()` with verdicts ok / retryable / hard-fail / hang plus a fake clock, following the repo's `*.testkit.ts` convention (`server/provider-auth.testkit.ts`, `server/loopback-request.testkit.ts`). |
| **W2.5** Outbox, lease, retry, sender | `packages/cezar/src/notifications/{outbox,sender}.ts` + tests | W1.7 | `reserve()` returns `undefined` on collision, proven by restarting the store and re-firing the same transition. Rows stuck `reserved`/`sending` past 10 minutes re-queue exactly once; a row older than `maxAgeMs` closes `dropped:'stale'` and stays in the log. Retry curve tested with an injected clock and seeded RNG; `Retry-After` overrides. Five consecutive hard failures set `backoffUntil` and flip to `degraded`. The `wx` lease with staleness reclaim gives a second instance `undefined` and it sends nothing. Every row passes `redactDeep`, stores header names only, and never stores an interpolated body. **The sender interval handle is `null` after the outbox drains**, asserted directly. `compact()` / `maybeCompact()` mirror the automations retention policy, and a partial NDJSON line is skipped rather than fatal. |
| **W4.5** Store observer | `packages/cezar/src/notifications/observer.ts` + test | W1.7, W2.5 | Exports `watchRunNotifications(store, sink)` returning an unsubscribe plus a `RunNotificationObserver` class with per-store `WeakSet` dedupe, so a store wired twice yields one listener. Subscribes to `('run', ...)` for transitions and to `('event', ...)` only for `provider-auth-required`. **The blocking test** (below). Zero I/O beyond one synchronous outbox append. At most one throttled `console.warn` per transport per hour, never an unhandled rejection. The ASK body comes from a bounded tail read for the last `ask.requested`. Each notification carries its owning project id and name. The five wiring call sites are handed to W1.1, not edited here. |
| **W4.7** HTTP handlers and CLI | `packages/cezar/src/server/notifications-routes.ts` (fills the scaffold's inert family), `packages/cezar/src/server/notifications-api.test.ts`, `packages/cezar/src/notifications/cli.ts` + test | W2.4, W2.5, W3.1 | Handlers fill the chained family; validation is middleware; `typed-bodies.test.ts` proves the routes reached `AppType`. Workspace-level single mount: `/api/v1/p/<boot>/workspace/notifications` must NOT answer. `contract-parity.notifications.test.ts` (scaffold-owned) is green in **both** directions. No secret and no full URL is reachable through any GET, log row or WS payload. `/test` bypasses dedupe, coalescing, quiet hours and the bucket, and returns the redacted verbatim result. `cez notify test <id>` exits 0 on delivered and 1 otherwise. The family stays **editable** under `CEZ_REMOTE=1`, pinned by a test. |
| **W4.9** Cockpit | `packages/web/src/routes/settings/notifications-section.tsx` (**extended, not created**) + test, `packages/web/src/components/transport-health.tsx` + test | W1.1, W4.7 | The existing browser-notification toggle in that file keeps its behaviour byte-for-byte: it still reads `normalizeNotifications(uiState.notifications)`, still PUTs `~/.cezar/ui-state.json` via `PUT /api/v1/workspace/ui-state`, still requests permission on enable only, and its existing test file passes untouched. No server-side transport reads that key. A second pane lists one row per instance: label, kind badge, independent enable switch, endpoint **host** only, health chip, one-line `lastError` with a stored timestamp, and a Send test button. An expander holds the per-event matrix driven by the GET's `events[]` (never a hardcoded client list), quiet hours and the rate limit. The add/edit dialog takes URL and auth env-var name with a live present / not-found indicator, and never renders a stored secret; editing without touching auth preserves it via `"__unchanged__"`, proven by a test. Live health arrives from the `notifications` WS topic subscribed **in this view**, returning its unsubscribe, with no `refetchInterval` and no second socket. Empty state reads "No transports configured. cezar sends nothing." and the cockpit URL source is displayed. |

**Sequencing.** W1.7 and W1.8 are leaves off the scaffold and run in parallel. W2.4 and W2.5 both
depend on W1.7 only. W4.5 needs W2.5's outbox. W4.7 needs W3.1 (the runtime must be reachable from
`project-context.ts`) as well as W2.4 and W2.5. W4.9 needs W4.7's routes and the scaffold's api
client. Nothing here may run `npm run test:e2e`, which is W5.1's global mutex.

**Not in phase 1:** a second transport `kind`, email, Web Push, and a
ServiceWorker. **WhatsApp *is* in phase 1** (Q2, plan D12): it is a member of the `transports` array,
not a transport `kind`, so it costs this feature no work package and no code. Adding a ServiceWorker would fix the mobile page-context throw the code already works
around (`run-notifications.tsx:76-88`), but it is a browser-delivery improvement to a browser
mechanism, not the headless gap this spec closes.

## Risks

- **The template becomes a mini-language**, growing expressions, loops and conditionals, and with
  them an injection surface where a run title containing a quote forges a JSON field.
  **Mitigation:** closed placeholder set, no control flow, unknown placeholders rejected at load,
  every substitution JSON-string-escaped, and the result must `JSON.parse` at load time. A test
  drives a run title containing quotes, braces, backslashes and a newline through the transport and
  asserts the body parses and carries the title as a single string value.
- **Zero-config violation**: cezar starts doing something it did not do before, or fails when the new
  state is missing. **Mitigation:** exact `CEZ_NOTIFY=1`; unset means no listener, no file, no timer,
  no boot cost. The flag-off byte-identity control below is the proof, and it must fail when the flag
  is forced on.
- **A restart pages the user about every run that already exists.** The browser avoids this with an
  in-memory map a server restart does not have. **Mitigation:** boot grace, first-sight silence, and
  the staleness ceiling, verified by restarting a store with 20 pre-existing runs across every status
  and asserting zero sends.
- **A token leaks** into the outbox, a console line, the GET, the WS payload or a run transcript.
  **Mitigation:** env references by default (the ngrok precedent), the `CEZ_NOTIFY_<ID>_TOKEN`
  spelling that `SECRET_NAME_RE` already scrubs, `redactDeep` before every append, header names only,
  write-only URLs, userinfo rejected at parse. Proven by a negative control **with its trigger**
  (below). `CODE_REVIEW.md:58` makes "secret written to disk" a merge blocker, so this is the risk
  that decides whether the PR lands at all.
- **Two disagreeing definitions of "this run wants a human".** The notifier includes `done` and the
  usage-limit hold, which `wantsAttention` excludes (`attention.ts:146-148`).
  **Mitigation:** the divergence is a recorded decision with its reason (Q12), the notifier does not
  import `wantsAttention`, and a test asserts there is no second status list under
  `src/notifications/`.
- **`queue.drained` flaps** and duplicates `run.finished` on a one-at-a-time machine.
  **Mitigation:** default off, opt-in per transport, fires only on an active-count `>=1 -> 0`
  transition where at least one run finished inside the window, and the spec says in writing that it
  is derived with no event behind it.
- **A timer on an idle machine.** **Mitigation:** demand-driven sender (interval `null` when the
  outbox is empty) and a demand-driven WS publisher (0 to 1 start, 1 to 0 stop), both asserted on the
  handle.
- **A notification failure blocks or fails a run**, the one outcome that makes this worse than
  nothing. **Mitigation:** structural, not careful (Architecture, four properties), and the blocking
  test below.
- **Two cockpits sharing a `CEZ_HOME` double-send**, or a crash mid-send loses a row.
  **Mitigation:** the `wx` lease with staleness reclaim plus reserve-before-send ordering, so a crash
  leaves a `reserved` row that the next boot re-queues once. Tested with two store instances over one
  temp home.
- **The deep link points at `http://127.0.0.1:4321` and is useless from a phone**, which is the exact
  scenario the feature exists for. **Mitigation:** discovery before configuration (Q15), and the GET
  returns `{value, source}` so a user seeing `loopback` learns why in one glance.
- **Route drift and the QA gate.** `bc-route-inventory.test.ts` fails on an uninventoried route, and
  the doc is scaffold-owned, so a notifications package that adds a route the scaffold did not create
  is red by construction. This feature is user-facing, so the PR carries `needs-qa` and cannot merge
  without `qa-approved` (`SDLC.md:69-71`); the manual path below is what a tester exercises, and the
  self-QA exception requires attached evidence.
- **Upstream merge cost.** Every file this feature adds is new, and every shared-file edit is the
  scaffold's, which keeps the conflict surface with a weekly-churning upstream `server.ts` down to one
  package rather than seven. If the feature is ever upstreamed, nothing needs stripping first, which
  is the whole point of D2 and D11.

## Verification

Written as negative controls wherever a control is possible. A test that passes whether or not the
mechanism works proves nothing, so each item below names **what must FAIL when the mechanism is
disabled**.

### Negative controls (each must go red when its mechanism is off)

1. **Flag-off byte identity.** With `CEZ_NOTIFY` unset, boot the server on a pinned empty `CEZ_HOME`,
   drive a run to `failed`, and assert: zero `fetch` calls, zero files created under
   `~/.cezar/notifications/`, no listener added to the store, and a `RunRecord` byte-identical to the
   no-feature build. **Negative control:** the same case with `CEZ_NOTIFY=1` and one configured
   transport must produce exactly one send. If both pass, the flag is decorative.
2. **The secret never leaks.** Configure a real 40-character token value, drive a full send plus a
   failure plus a retry, then grep every artifact for that literal string: the outbox NDJSON, every
   `console` call, the GET response body, every log row, and the WS payload. Zero hits.
   **The trigger is real:** the token is genuinely present in the config and genuinely sent in a
   header, so a green run means something. **Negative control:** with `redactDeep` removed from the
   append path, the outbox grep must find it.
3. **A failing transport cannot touch a run.** Three transports, one throwing synchronously, one
   returning a rejected promise, one hanging forever. Each must leave a run's status transitions
   byte-identical to a run with no notifier attached, and the run's NDJSON must gain no extra line.
   **Negative control:** replace the observer's `try/catch` with a bare call and the synchronous-throw
   case must fail. Plus a grep asserting no `await` of a notification path exists in
   `packages/cezar/src/workflows/run.ts` or `packages/cezar/src/runs/store.ts`.
4. **Monitoring is silent.** A run transitioning into `activity: 'monitoring'` produces zero
   notifications. **Negative control:** remove the monitoring clause from the decider and the case
   must fail. (`.ai/specs/2026-07-18-subagent-monitoring-status.md:214-215` pins the browser half of
   the same rule.)
5. **Usage limit is not a failure.** `status -> failed` **with** `autoResumeAt` yields exactly one
   `run.usage-limit` and zero `run.failed`. **Negative control:** drop the `autoResumeAt` check and
   the case must produce `run.failed`.
6. **At-most-once across a restart.** Fire `status -> failed`, restart the store, fire the same
   transition again: exactly one outbox row and exactly one send. **Negative control:** disable the
   `reserve()` collision check and the second fire must send.
7. **No replay storm.** Restart a store holding 20 pre-existing runs spread across every status and
   assert zero sends. **Negative control:** remove the boot grace and the first-sight rule and the
   case must send.
8. **One mapping table.** A source-level test asserts that no file under
   `packages/cezar/src/notifications/` other than `decider.ts` contains a bare `RunStatus` string
   literal, and that `wantsAttention` is imported nowhere in the directory. **Negative control:**
   paste a `'waiting'` literal into `registry.ts` and the test must fail.
9. **No `permission.*` event exists.** `notificationEventSchema` contains no member matching
   `permission.`. **Negative control:** add one and the test must fail.
10. **Upstream purity.** A grep asserts `loki`, `lokimessages` and `imsg` appear nowhere under
    `packages/cezar/src/` or `packages/contract/src/`, run **alongside** the test that proves a send
    to a SPEC-417-shaped ingress works from JSON config alone, including the required `dedupeKey` and
    the `transports` array. Either half on its own is meaningless: the grep alone passes on a build
    that cannot do the send, and the send test alone passes on a hardcoded vendor branch. **Negative
    control:** drop `{{dedupeKey}}` from the closed placeholder set and the config must fail to load
    with a named error rather than sending a body with a literal `{{dedupeKey}}` in it.
11. **No clock-derived GET field.** Issue the same
    `GET /api/v1/workspace/notifications` three times inside one test with a stub transport that has
    a `backoffUntil` two seconds out, and compare bodies byte-for-byte, the `route-parity.test.ts`
    discipline. `health.status` must read `degraded` in all three. **Negative control:** add an
    `ageMs` field, or derive `health.status` from `backoffUntil` against the clock instead of reading
    the stored enum, and the case must fail.
12. **The idle machine holds no timer.** Assert the sender's interval handle is `null` after the
    outbox drains, and that the WS publisher stopped at 1 to 0 subscribers. **Negative control:**
    replace the demand-driven start with a fixed `setInterval` and the assertion must fail.
13. **Template injection.** Drive a run title containing `"`, `{`, `}`, `\` and `\n` through a
    templated transport; the outgoing body must `JSON.parse` and carry the title as one string value
    with no extra keys. **Negative control:** remove the JSON escaping and the case must fail.

### Table tests (pure, no store, no clock, no socket)

`decide()` covering: first sight silent, unchanged status silent, `waiting` yields `run.needs-you`
with the last `ask.requested` text, `review` yields `run.review` with the PR URL when present,
coalescing across 12 same-project runs producing five names plus "and N more", batches never mixing
projects, quiet hours passing urgent only, a DST boundary that must not become a 25-hour silence,
token-bucket boundary folding plus one suppression summary, and `queue.drained` staying silent when
the active count never reaches zero.

Outbox tests under the vitest-pinned `CEZ_HOME` sandbox (`packages/cezar/vitest.setup.ts` pins it and
`assertCezarHomeWriteIsSandboxed` backstops it): restart re-queue, staleness drop, dedupe collision,
lease contention between two instances, partial NDJSON line skipped.

### Manual verification (the QA path, which is what makes the PR mergeable)

`CEZ_DRY_RUN=1 CEZ_NOTIFY=1 npm run dev`, then in Settings, Notifications, add a transport pointed at
a local sink (`nc -l 8099` or an `ntfy` topic), and press **Send test notification**. Expected:
the message arrives, the row's health chip goes `ok`, and the returned `DeliveryResult` shows the
HTTP status. Then break it (wrong port) and press it again: the chip goes `degraded`, the verbatim
error appears on the row, the outbox log shows the retries, and **no run is affected**. This is the
`qa-approved` evidence per `SDLC.md:69-77`; a screenshot of both states satisfies the self-QA
exception.

For the real end-to-end, set `CEZ_NOTIFY_TOKEN` to a `scope='notify'` key, run the one-row recipe
above, press Send test, and confirm the iMessage arrives on the phone. Then, **once SPEC-417's P4.8
Telegram provisioning and its inbound-first enrollment have landed** (before that, this leg correctly
returns `not_enrolled` and delivers nothing, which is a pass for the notifier and a not-yet for the
channel), add `"telegram"` to the row's `transports` array and press it again: both channels arrive
from the same row, from one request carrying one `dedupeKey`. `"whatsapp"` is the same single edit
with the same pass criterion: enrolled and inside the 24-hour session window the message arrives,
outside it the leg returns `window_closed`, and either way the notifier passed because the receiver
answered per channel. That is the whole feature in one button, which is exactly why the button
exists.

### Validation

The gate is five commands, in this order. **There is no lint step and no format step in cezar.**

```bash
npm run typecheck      # has "pretypecheck": "npm run build:server"; needs its own worktree
npm test
npm run test:unit
npm run build
npm run test:package
```

Notes that decide whether a green run means anything:

- `packages/contract` has **no `test` script**; contract-only acceptance is `npm run typecheck`.
- **Do not run `npm run test:e2e`.** One instance, one port, one lockfile. W5.1 owns it as a global
  mutex.
- Run the gate in your own git worktree with your own `npm ci`. `pretypecheck` writes
  `packages/cezar/dist`, so two agents running the gate in one checkout corrupt each other.
- Green gates are necessary and not sufficient (`SDLC.md`). This is user-facing, so the PR carries
  `needs-qa` until a tester applies `qa-approved`, and the manual path above is what they exercise.
