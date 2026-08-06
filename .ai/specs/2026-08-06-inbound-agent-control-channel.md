# Inbound agent control channel

> **Status:** proposed, not started
> **Programme:** the inbound half of F6. Companion to `../../chat/.ai/specs/SPEC-417-2026-08-06-cezar-notification-agent.md` (outbound) and to `2026-08-06-workspace-notes-cross-project.md` (F3 feature B, the notes inbox this rides on).
> **Authority above this file:** `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`. Where this spec and the PLAN's decision table disagree, the table wins.

## Repo ownership: which repo owns which half

**The bulk of this work is in `chat/`, not in `cezar/`.** This file lives in `cezar/` because
the cezar half is the one that decides whether the feature is safe, and because the cezar half
is the one that must survive an upstream review. But the line count and the schema live in the
Cloudflare estate, and an agent picking up this spec must know that before it starts.

| Half | Repo | What it owns | Rough size |
|---|---|---|---|
| **Queue, identity, authorization, audit, the tool** | `chat/` | platform D1 tables and migration, `POST /cezar/v1/commands/claim` and `/ack`, the sender allowlist, the tier ladder, the confirmation protocol, the kill switch, the `cezar_commands` audit table, and one local capability module in the chatbots worker | ~4 work packages |
| **The poller and the replay allowlist** | `cezar/` | one generic outbound poller, one path canonicaliser, one canonical-key allowlist, one durable receipt, one `CEZ_CMD` flag family, `.env.example`, `BACKWARD_COMPATIBILITY.md` | ~1 work package |

**The two repos carry opposite compatibility rules and an agent working both halves in one
session will import the wrong instinct.** `chat/AGENTS.md` says pre-launch, change contracts in
place, no shims. `cezar/` is a published npm package and PLAN dispatch clause 6 says backward
compatibility wins inside it. Both are correct in their own repo. Concretely for this spec: the
platform queue schema may be dropped and reshaped freely; the cezar poller may add config keys
and may add an optional field, and may not rename or remove one.

## The line anchors in this file, and their baseline. ADDED 2026-08-06 (residual pass 4).

**Every `file:line` below was taken against the working tree, not against `HEAD`, and four of the
cited files have moved out from under it since.** The baseline itself is forced rather than sloppy:
`notes-routes.ts`, `knowledge-routes.ts`, `packages/contract/src/notes.ts` and the rest of the
F3/F4 surface this spec builds on are **untracked** in this checkout, so they exist at no commit and
only a working-tree anchor can name them at all. But `server.ts`, `run.ts`, `capabilities.ts` and
`automations/scheduler.ts` are tracked **and dirty**, a parallel session is still editing them, and
their anchors drifted while this spec was being corrected. Re-measured 2026-08-06 against the
working tree:

| cited in this spec as | the symbol it means | actually at |
|---|---|---|
| `run.ts:3380` | `spawn('bash', ['-lc', command], {cwd, env})` | `run.ts:3441` |
| `run.ts:1031` | the `queued` re-queue, `this.queue.push(run.id)` | `run.ts:1058` |
| `run.ts:1055-1060` | the run rewritten to `status: 'failed'` in `recover()` | `run.ts:1101-1108` |
| `run.ts:1061-1067` | `continueRun(..., RESTART_CONTINUATION_PROMPT, true)` | `run.ts:1110-1114` |
| `run.ts:1080` | `void this.pump()` closing `recover()` | `run.ts:1129` |
| `run.ts:212` / `:540-541` | `QUEUE_WATCHDOG_MS` / its `setInterval` | `run.ts:214` / `:542` |
| `server.ts:1366-1390` | `const resolveProjectScope = async (...)` | `server.ts:1373-1397` |
| `server.ts:1367-1371` | the `raw === undefined` short circuit | `server.ts:1374-1378` |
| `server.ts:1368-1378` | the `default` / boot-id short circuit | `server.ts:1382-1385` |
| `server.ts:1380` | `contexts.context(raw)` | `server.ts:1387` |
| `server.ts:388-401` | `projectRouteManifest(app)` | `server.ts:395` |
| `server.ts:5107` | `.use('*', resolveProjectScope)` on `v1` | `server.ts:5114` |
| `server.ts:5114` | `.route('/', runsRoutes)` on `v1` | `server.ts:5121` |
| `server.ts:5124-5125` | `knowledgeRoutes` / `sourcesRoutes` on `v1` | `server.ts:5131-5132` |
| `server.ts:5129-5142` | the `workspaceV1` family list | `server.ts:5136-5149` |
| `server.ts:5140` | `.route('/', notesRoutes)` | `server.ts:5147` |
| `server.ts:5150-5153` | the "Workspace families mount LAST" comment | `server.ts:5156-5159` |
| `server.ts:5155-5157` | the three `route(...)` mounts | `server.ts:5161-5163` |
| `server.ts:1285` / `:1291` | `isHostedMode` defined / applied | `server.ts:1292` / `:1298` |
| `server.ts:1204` / `:3011-3012` | `ensureLaunchKey(...)` / `launchKeyRoutes` | `server.ts:1211` / `:3018-3019` |
| `server.ts:3634-3693` | `.post('/runs/:id/messages', ...)` | `server.ts:3641` |
| `capabilities.ts:136-158` / `:142` | `resolveCapabilities` / its `localHandoff` | `capabilities.ts:159` / `:165` |
| `automations/scheduler.ts:127` | `Math.min(6 * 60 * 60_000, 60_000 * 2 ** (failures - 1))` | `scheduler.ts:128` |

Re-checked in the same pass and correct as written, so do not "fix" them: every anchor in
`project-context.ts`, `notes-routes.ts`, `knowledge-routes.ts`, `automations/store.ts`,
`automations/task-template.ts`, `paths.ts`, `origin-guard.test.ts`, `host-guard.test.ts`,
`update-check.ts`, `core/secret-redaction.ts`, and every `chat/` anchor sampled
(`imsg-webhook.ts:26-39`, `scheduling.ts:100,101,104,107`, `agent.ts:3848`, `agent.ts:4194-4200`
with `!mcpToolNames.has(name)` at `:4197`, `key-scopes.ts:28` with the `line`-removal comment at
`:20-26`, `internal-admin.ts:38-44` and `:148-149`, `internal.ts:47-52`, `admin.ts:15`).

**Match the symbol, never the number.** `server.ts` and `run.ts` are under concurrent uncommitted
edit and will move again before P5.4 starts. This is the same failure the `knowledge-routes.ts`
anchor correction under requirement 2 fixed one round earlier, recurring in the four files nobody
re-checked afterwards, and `run.ts:3380` is the most-cited line in this spec.

## Relationship to the two specs this touches

**This EXTENDS SPEC-417. It does not supersede it.** SPEC-417 owns `agt_cezar`, the `lok_*` key
vocabulary (`chat/packages/types/src/key-scopes.ts`), the `notify_subscribers` /
`notify_targets` / `notify_events` tables, and the outbound ingress. All of that is a
prerequisite here and none of it changes. This spec adds a second, separately scoped credential
and a second route family on the same worker, and it reuses SPEC-417's fan-out unchanged as the
**only** path by which an outcome ever reaches the owner.

**One clause of SPEC-417 IS superseded, and it must be marked in place in that file.**
SPEC-417's reply-path paragraph (lines 632-638, under `### Release phase 2: Telegram and the reply
path (P4.8)` at `:621`) specifies the reply path as "one `agent_mcp_servers` row pointing at an MCP
server cezar exposes on the VPS (`list_runs`, `get_run`, `send_feedback`, `retry`) plus a
capability grant. No schema change, no new transport, no second agent." That clause presumes an
HTTP-reachable cezar, which is the transport this spec rejects (see Risks), and it presumes MCP,
which cannot carry a mutation safely: the mutation gate that works in this estate is a runtime
hook that writes a durable pending row and intercepts the next inbound text before inference
(`capabilities/trading/pending-trades.ts:64-86`, and the mutation itself at
`capabilities/trading/runtime/trade-conversation.ts:782-786`, `placePendingTrade.call(...)`),
and a hook has no MCP client, so an MCP-provided mutator can only be asked nicely rather than
gated. MCP tools also bypass the check-fire filter wholesale (`agent.ts:4194-4200`, the exemption
is `!mcpToolNames.has(name)` at `:4197`), which would make a cezar mutator reachable
from an unattended timer fire. **P4.8's reply-path paragraph must carry a bolded `SUPERSEDED
2026-08-06 by cezar/.ai/specs/2026-08-06-inbound-agent-control-channel.md` lead-in, with the
original text left below it**, per the workspace correction rule. The read tools it names are
still the right tools; they arrive here as replayed GETs and, later, as a local capability
module, not as an MCP binding.

**This EXTENDS the notes pipeline in `2026-08-06-workspace-notes-cross-project.md`. It does not
duplicate it.** That spec already declares `POST /api/v1/workspace/notes` "THE single write
path. Cockpit textarea, phone Shortcut and webhook all use this route", already names a webhook
and `curl` as first-class callers, and already ships a closed `source` enum whose third member is
`api` (`packages/contract/src/notes.ts:22`) plus a `sourceRef` free-text field (`:108`). **A text
message is a fourth caller of that route and needs no cezar schema change, no new route, and no
enum member.** Everything that spec says about the notes inbox holds unchanged here: the store is
`~/.cezar/notes.json` outside every checkout, `process` creates nothing ever, `approve` is the
only creating path and stays human-gated in the cockpit, and there is no `?auto=1`.

Two corrections this spec makes to that spec's incidental assumptions, both small and both
needing a one-line edit there:

1. That spec says the phone path requires "an existing `cezar server-install --domain`
   deployment, so a Shortcut POSTs to `https://<domain>/api/v1/workspace/notes` behind that
   install's Basic Auth". This spec provides a fourth path that opens no port and needs no
   domain. The sentence is not wrong, it is now incomplete.
2. `sourceRef`'s docblock says "shortcut name, filename, or script id". This spec writes an
   opaque command id into it (`cmd_QK7T2Z...`), never a handle or a chat id. See Data Models: a
   note's `body` and its `sourceRef` both ride into the note pass prompt, so a chat id becomes
   model input. This is not a D9 argument.

---

## TLDR

Texting `agt_cezar` must be able to do things inside cezar. cezar has no authentication worth
the name, no identity, no ACL and no rate limit, and one POST away from its own loopback API is
`spawn('bash', ['-lc', command], { cwd: state.cwd, env: process.env })`
(`packages/cezar/src/workflows/run.ts:3380`) on the workstation that holds the estate's
credentials. So the transport question and the authorization question are different questions
and only one of them is hard.

**The transport is a short poll.** cezar dials out every 5 seconds to one narrow route on the
Loki platform, claims zero or more leased commands, and **replays each one as an ordinary HTTP
request against its own `127.0.0.1` server**, gated by a canonical-key allowlist that is
empty by default and bounded above by a compiled-in set no configuration may exceed. No inbound port, no tunnel, no DNS record, no change to the bind host, no
relaxation of the loopback Host guard, and no new command vocabulary inside cezar. Outcomes ride
SPEC-417's existing `POST /notify/v1/events` back to the phone, so one direction carries both
halves of the conversation and there is one dedupe domain rather than two. **That leg is F4's
notifier plus `CEZ_NOTIFY=1` plus a `loki` transport row (PLAN D23), which is a real dependency and
not a free reuse**: without it every outcome bubble in this design is dropped, silently, which is
the one failure mode the whole outcome path exists to prevent. See "The outcome leg".

**The authorization model is the feature.** Text may always reduce capability and may never
increase it. Operations are laid on a five-tier ladder; phase 1 ships tiers 0 and 1 only, whose
entire surface is reads plus one inert append into the notes inbox. **CORRECTED 2026-08-06
(residual pass 4): phase 1's shipped surface is the inert append and nothing else.** T0 is
allowlistable and unreachable, because no tool emits a read and no leg carries a read's response
back to the owner. See "Phase 1 ships one tool" under Phases. **CORRECTED 2026-08-06:** the
worst case of a total compromise of every credential in this design is **attacker-authored text in
a human-reviewed queue that no automation can promote**: it becomes model input on the first human
press (`process`) and executable only on a second (`approve`). This sentence previously read "spam
in an inbox that a human must still approve before anything runs", which understated it, because a
note body rides into the note pass prompt and is therefore stored prompt injection, not inert
data. See the T1 obligations in Authorization section 2. Tier 3 (start a run) is not scheduled, is not reachable by any
configuration this spec ships, and is described here only so that the door it would need is
designed rather than improvised later. Tier 4 (change who may do what, or where notifications
go) has no configuration that turns it on, ever.

Everything on the cezar side is behind `CEZ_CMD`, which must equal exactly the string `'1'`.
With no configuration there is no route, no timer, no dial and no outbound socket.

---

## Problem

The owner asked for three things by name: **create tasks, add comments, and manage cezar
infrastructure**, by texting the agent that already texts him.

The first is already designed and is nearly free. "Create a task" is exactly the notes pipeline
in F3 feature B: a note lands in the inbox, one agent pass proposes N tasks across N projects,
and a human approves. Nothing about that needs inventing.

The second has no surface yet. Comments are F5, phase 3, fork-private. **CORRECTED 2026-08-06:**
this paragraph previously said "PLAN line 88 blocks phase 3 on precisely the decision this spec is
making", and that was a misreading a reader could have scheduled work on. PLAN:87-89's phase-3
precondition is the **shared-instance auth model**, expanded at PLAN:281-285: two humans on one
cockpit port with no login, bearer token, user identity, per-project ACL or rate limit, so an
assignee is a free string anyone reaching the port may set. This spec does not answer that and
structurally cannot: it authorizes on the Cloudflare plane, and cezar never learns an identity
(see Authorization section 2, "cezar's own check is not an authorization model"). That precondition
is an owner decision (PLAN:285), not a decision a spec may settle. T2 stays blocked on F5, and F5
stays blocked on the owner. Through phases 1 and 2 the only durable
inert object cezar has is a note. **"Add comments" must not quietly become
`POST /runs/:id/messages`**, which is a prompt turn that spends tokens and changes a running
agent's behaviour (`packages/cezar/src/server/server.ts:3634-3693`). That is dispatch wearing a
comment's clothes.

The third maps entirely onto the tier that text cannot carry. "Manage cezar infrastructure"
means notification transports, source connections, ops leases, the mirror, and the `CEZ_*` flags:
every one of them changes who may do what or where data goes. A confirmation for that class of
change is satisfiable by the same forged channel that requested it, so the ceremony adds nothing.
The honest answer is that this ask is served by the cockpit and by SSH, and this spec says so
rather than shipping a control that reads as protection and is not.

Underneath all three sits the structural problem. cezar is a process on a home Mac behind NAT,
and the platform is Cloudflare Workers. There is no path from one to the other that does not
either open something on the Mac or have the Mac dial out. And whichever path is chosen, the
claim "the owner sent this" is not currently provable on the highest-traffic transport:

```
chat/domains/chatbots/worker/src/routes/imsg-webhook.ts:26-39

  const signature = c.req.header("X-Webhook-Signature");
  if (signature) {
    const valid = await verifyWebhookSignature(signature, rawBody, c.env.WEBHOOK_SECRET);
    if (!valid) { ...; return c.text("Invalid signature", 401); }
  }
```

There is no `else`. Omitting the header skips verification entirely. That worker is publicly
reachable (`bots.lokimessages.com` is a `custom_domain` in `wrangler.jsonc:80-85`, and
`/webhook/imsg` is mounted with no auth middleware ahead of it at `src/index.ts:87`), and
`payload.data.sender_handle.handle` from that same unauthenticated body is what
`isAdminHandle(ctx.env.ADMIN_HANDLES, ctx.handle)` compares. Every other transport already fails
closed: Telegram at `telegram-webhook.ts:112-118`, WhatsApp at `whatsapp-webhook.ts:121-128`,
Composio at `composio-webhook.ts:98-118`. iMessage is the exception, and it is the one the owner
actually uses.

---

## Solution

### Transport: short poll with an allowlisted replay

cezar polls. It does not listen, it does not hold a socket open, and it never receives a command
frame in a vocabulary of its own.

```
every 5s (jittered)
  POST {CEZ_CMD_ENDPOINT}/cezar/v1/commands/claim      Authorization: Bearer $CEZ_CMD_TOKEN
    -> { leaseId, commands: [ { commandId, deliveryNo, method, path, bodyRaw, tier,
                                issuedAt, expiresAt, expiresAtUnix, sig } ] }

for each command, in exactly this order
  1. verify sig            HMAC-SHA256 over the canonical string (see "Signing and the two
                           clocks"), forward-skew bound on `t`, hard stop on expiresAt
  2. canonicalise          ONE URL object, built once from the raw path and never mutated:
                           reject %2e / .. / empty segments; reject if url.pathname is not
                           byte-identical to the raw path's pathname part; REJECT any path
                           whose 3rd segment is the literal `p`
                           -> { key: "POST /api/v1/workspace/notes", url }
                           the KEY is url.pathname only; url.search rides to fetch unmatched
  3. config loaded?        if the config was REFUSED as a whole, stop here
                           -> refused_config_load
  4. allowlistable         key must be inside the compiled-in CEZ_CMD_ALLOWLISTABLE
                           (checked here, not only at config load)
                           -> refused_not_allowlistable
  5. check the key         Set.has against the loaded allowlist, exact, default-deny, empty by
                           default                            -> refused_local_allowlist
  6. reserve a receipt     durable, keyed on commandId, written BEFORE the replay
                           already reserved (a redelivery) -> duplicate_receipt, no replay
  7. replay                fetch(url, { method, body })   <- the SAME url object from step 2,
                           never mutated, so url.pathname + url.search is byte-identical to
                           the raw path
  8. POST .../ack          { commandId, deliveryNo, outcome, replayStatus, receiptId }
                           platform moves the queue row leased -> acked in the same statement
```

**The order of 1 to 5 is normative, not incidental**, and each step's refusal is a different fact
on the audit row. **CORRECTED 2026-08-06: the replay order was never stated, and two of these
steps were in the wrong relative order in the reader's head.** Signature first, because an
unverified envelope has no admissible content at all. Canonicalisation second, because everything
after it compares a key, and because its `/p/` refusal must land before anything can admit the
path. **Config-load failure third**: if the config was refused as a whole the effective allowlist
is `[]` and the ack is `refused_config_load`, which says "the owner's intent was not applied", not
"the owner did not ask for this". `CEZ_CMD_ALLOWLISTABLE` fourth and the loaded allowlist fifth,
in that order,
because the spec's own "even if the in-memory allowlist somehow contains it" clause below makes
the compiled-in bound dominant: an allowlistable violation means the platform catalogue enqueued
a key no configuration may ever name, which is a higher-severity fact than an ordinary allowlist
miss and must not be masked by one.

Six properties fall out of the replay shape, and each of them is the reason a command
**vocabulary** was rejected:

1. **cezar stays generic (D2).** It defines no command schema and knows nothing about Loki. What
   it defines is "poll a configured endpoint and replay allowlisted requests against myself". A
   `{verb, project, args}` frame would be a Loki-shaped schema living in cezar `src/` in a
   generic costume.
2. **Every reachable route keeps its own zod validation and its own `CEZ_*` gate.** With
   `CEZ_NOTES` unset, `POST /api/v1/workspace/notes` answers 409 (PLAN D19) whether the caller
   was the cockpit, `curl`, or the replayer. One gate, not two, and no second place for a flag
   to be checked. **This is also the only bound on a command's arguments, and that is deliberate
   rather than an oversight.** The allowlist keys an operation, not its inputs: a POST body has
   never been matched, and as of 2026-08-06 a query string is not matched either (canonicaliser
   rule (e)). Both are validated where they are consumed, by `jsonZodValidator` and
   `queryZodValidator` at the route (`notes-routes.ts:44,47`, `knowledge-routes.ts:164`), which is
   the same discipline and the same one gate.
3. **No new dispatcher, and therefore no new place for RCE to live.** New executor code on the
   Mac is exactly where a remote-control bug would be. The replay adds no executor at all.
4. **The loopback guard needs no relaxation, and this is asserted today.** A loopback replay
   sends `Host: 127.0.0.1:4321` and no `Origin` header, and that exact request already has a
   passing test: `packages/cezar/src/server/origin-guard.test.ts:175-179`, *allows a same-origin
   write with no Origin header (non-browser caller)*, expecting **201** on `POST /api/v1/runs`.
   cezar's exposure is byte-identical before and after this feature.
5. **"What may a text do" becomes a list you can read**, not code you have to audit.
6. **`ws` is not needed.** It is in the dependency budget and the client half is genuinely
   unused, and none of that is a reason to use it. This design needs native `fetch` plus
   `AbortSignal.timeout`, whose precedent is already in the tree
   (`packages/cezar/src/update-check.ts:9,15`). Nothing new enters D7's budget under any
   candidate, so "already in the budget" was never a discriminator.

### The one sharp edge of the replay shape

The allowlist is the entire local security model, and a broken allowlist is a text-message
shell. Four requirements, all default-deny, in this order.

**1. Canonicalise before anything else, and never enumerate.** This requirement is first because
it is the one the earlier draft of this section got wrong. That draft said "normalise the path,
match exactly", and assumed each route has one spelling. It has more than one.
`runsRoutes` is registered on the `v1` sub-app (`server/server.ts:5114`) and that sub-app is
mounted **twice** (`:5155-5156`), at `/api/v1/p/:projectId` and then at `/api/v1`.
`resolveProjectScope` (`:1366-1390`) accepts `undefined` (the boot project), the literal
`default`, the boot project's id, **and any registered project slug** via `contexts.context(raw)`
(`:1380`).
So the live spellings of `POST /api/v1/runs` number `2 + |registered projects|`: at least three,
unbounded above, and mutable at runtime by `POST /api/v1/projects`. An enumerated list is not
merely fragile here, it is **impossible to write correctly**, because it would need `2 + N`
entries per route with `N` unknown at config-write time.

> **CORRECTED 2026-08-06: `/p/<id>` is REJECTED, never erased. The erasure design below was a
> remote-code-execution bypass and a reader may have acted on it.** The original text of step (d)
> read: "If segment 3 is `p`, validate segment 4 against `PROJECT_ID_RE`
> (`^[a-z0-9][a-z0-9-]{0,63}$`, `workspace/config.ts`) or the literal `default`, then **erase
> segments 3 and 4** and return the erased value separately as `projectScope`", and the paragraph
> under it read "**The key answers "what", never "where".** `projectScope` is returned and recorded
> on the receipt; it is never folded into the key."
>
> **The key answering only "what" is exactly the defect.** `where` is what triggers execution, and
> the raw URL still carried `/p/<id>/` to `fetch`. `v1` mounts `use('*', resolveProjectScope)`
> (`server.ts:5107`) **ahead of every handler in the family**, so a signed
> `GET /api/v1/p/<anyRegisteredProjectId>/knowledge` canonicalised to the allowlisted key
> `GET /api/v1/knowledge`, was admitted, and then hit the resolver, which for a non-boot id calls
> `contexts.context(raw)` (`server.ts:1380`) and builds on first touch. `ProjectContexts.build()`
> (`project-context.ts:301`) does, **before any handler runs**: `RunStore.open(dataDir,
> {keepLive: true})` (`:310`), `pruneOrphans` (`:358`), `reclaimWorktrees` (`:364`), then
> `await manager.recover()` (`:366`), which re-queues `queued` runs (`run.ts:1031`) and, for a
> `running` one, rewrites it to `failed` and calls
> `continueRun(run.id, {text: RESTART_CONTINUATION_PROMPT}, true)` (`run.ts:1061-1067`), then
> `void this.pump()` (`:1080`), resuming the workflow into
> `spawn('bash', ['-lc', command], {cwd: state.cwd, env: process.env})` (`run.ts:3380`).
>
> **The flag state of the handler is irrelevant**, and so is the existence of a handler. Hono
> composes matched middleware and terminates the chain with `notFoundHandler`
> (`node_modules/hono/dist/hono-base.js:290-303`), so the flag-gated inert 200 at
> `knowledge-routes.ts:150-152` (`if (!store) return c.json(EMPTY_KNOWLEDGE_RESPONSE)`, the
> constant at `:67-74`; **CORRECTED 2026-08-06**, this cited `:67`, which is the constant's
> declaration rather than the handler that returns it) runs *after* `recover()`, and a `/p/<id>/`
> path with **no** scoped
> handler at all still runs the resolver on the way to its 404. No config error, no
> attacker-supplied allowlist entry, no platform compromise required: one signed command whose
> `path` names one registered non-boot project.
>
> `default` and `<bootId>` short-circuit to `bootContext` today (`server.ts:1368-1378`), so they
> are harmless only by a runtime property the canonicaliser cannot see. That is not a property to
> depend on, which is why the rule below is unconditional on segment 4.

The fix is one function, `canonicalise(method, rawPath, port) -> {key, url} | reject`, in
`packages/cezar/src/command/canonical.ts`:

  a. Build **one** `URL` object against `http://127.0.0.1:<port>` and hand **that same object** to
     `fetch`. Never re-parse, never mutate it, and never match a string while fetching a
     separately parsed URL: `new URL` collapses `..` but not `%2e%2e`, so matching the raw and
     fetching the parsed are two different paths and the gap between them is the exploit.
  b. Reject if the raw path matches `/%2[eEfF]/`, or if any segment is empty, `.` or `..`, or if
     `url.origin` moved.
  b2. **Reject unless `url.pathname` is byte-identical to `rawPath`'s pathname part** (everything
     before the first `?` or `#`). **CORRECTED 2026-08-06: this used to be asserted as a fact and
     it is not one.** `new URL` re-spells a path in at least two ways that matter, both measured
     on node v22.12.0 against `http://127.0.0.1:4321`: it treats a backslash as a slash in a
     special scheme, so the raw path `/api/v1\p\proj9\knowledge` has **no third segment at all**
     when split on `/` (`segs[3]` is `undefined`) while `url.pathname` is
     `/api/v1/p/proj9/knowledge`; and it percent-encodes, so `/api/v1/kn owledge` becomes
     `/api/v1/kn%20owledge` and `` /api/v1/knowledge`q `` becomes `/api/v1/knowledge%60q`.
     The backslash case is the sharp one: it is a live evasion of rule (d), because (d) reads the
     raw string and the fetch reads the parsed one. It does not reach a replay **today** only
     because the resulting key is not in `CEZ_CMD_ALLOWLISTABLE`, which is protection by the
     character set of a list rather than by the rule that exists for it, and it would be reported
     as `refused_local_allowlist` rather than as the highest-severity `refused_project_scope`. So
     this is a reject condition sitting beside the `%2[eEfF]` reject, not an assumption, and
     rules (c), (d) and (e) all read `url.pathname`, never `rawPath`.
  c. Require the `/api/v1/` prefix, on `url.pathname`.
  d. **If segment 3 of `url.pathname` is the literal `p`, reject unconditionally with
     `refused_project_scope`, before segment 4 is looked at at all.** Not validated, not erased,
     not rewritten. See the rule under requirement 3.
  e. `key = "${METHOD} ${url.pathname}"`, **pathname only: the query string is never part of the
     key and is never matched.** `url.search` rides to `fetch` on the same unmutated object. So
     the fetched target is `url.pathname + url.search` and the key is its pathname half.

**The key answers "what" AND the URL is the "where".** **CORRECTED 2026-08-06: the query string
was unspecified, and the sentence that stood here ("the two are the same bytes ... there is no
second string, so there is nothing for the key and the target to disagree about") was false the
moment a command carried one.** `path` is one signed field and it was keyed whole, so
`GET /api/v1/knowledge/search?q=tunnel` produced the key
`GET /api/v1/knowledge/search?q=tunnel`, which is in no allowlist and in no catalogue, and was
refused `refused_not_allowlistable`. Two of phase 1's six allowlistable keys are query-driven and
were therefore reachable only in their useless form: `knowledgeSearchQuerySchema`
(`knowledge-routes.ts:76-84`) reads `q`, `type`, `tag`, `status`, `root`, `limit`, `offset`, and
the handler searches `q ?? ''` (`:164-175`); `notesListQuerySchema` (`notes-routes.ts:35-39`)
reads `status`, `projects`, `limit`. Every one of those is `.optional()`, so the bare path was
admitted and answered, which is why this failed quietly rather than loudly: an unfiltered search
and an unfiltered list are not errors, they are wrong answers. **The rule: the key derives from
`url.pathname` only; the query rides on the same unmutated `URL` to `fetch` and is never
matched.** What that trades away is stated rather than hidden: the allowlist bounds **which
operation** a text may reach and does not bound its arguments, exactly as it already does not
bound a POST body. The bound on arguments is each route's own zod validation, which every
reachable route keeps (property 2 above), and `queryZodValidator` rejects an out-of-schema query
at the route rather than at the allowlist. The canonicaliser computes no target; it decides
admissibility of the one target it was handed. `projectScope` is therefore always `null` in
phase 1 and stays on the receipt only as a column that will carry a value if a later phase ever
admits a second spelling deliberately.

**Rejected alternative, and why: rewriting the target instead of refusing it.** The tidy-looking
fix is to erase `/p/<id>` *and* rewrite `url.pathname` so the key and the URL agree again. Reject
it, for three reasons. It must mutate `url.pathname` in place to keep the identity assertion in
negative control 4(c) true, which reopens the raw-versus-parsed gap rule (a) exists to close. It
retargets every scoped spelling onto the boot context, so a receipt reading
`projectScope: <otherProjectId>` would be a false statement about where the request ran. And it
leaves a live erasure branch that a later per-project re-scoping can silently re-point at an
arbitrary context. The cost of refusing instead is small and bounded: in phase 1 only
`GET /api/v1/knowledge` and `GET /api/v1/knowledge/search` are scoped families at all (the other
four allowlistable keys are workspace-level and have no scoped meaning), so phase 1 can address
only the boot project and loses no behaviour it ever had.

**2. Match exactly, never by prefix, and let a literal beat a parameter.** A prefix match on
`/api/v1/workspace/notes` also admits `/api/v1/workspace/notes/<id>/approve`, which is the only
creating route in the family. Matching is two steps and nothing else:

  a. `Set.has(key)` against the parameterless keys. Every phase-1 write is decided here.
  b. Only if (a) misses, compare against the keys containing `:*`, **segment-count-exact**, where
     a `:*` position matches exactly one segment satisfying `^[A-Za-z0-9_-]{1,64}$`.

Never `startsWith`, never a glob, never a regex over the whole path. Step (a) running first is
what makes a literal beat a parameter, and that ordering is load-bearing rather than cosmetic:
cezar's own route table has literal siblings at parameter depth (`GET /knowledge/search` and
`GET /knowledge/proposals` sit beside `GET /knowledge/:id`, `knowledge-routes.ts:164,186,240`).
Hono resolves those static-beats-param **regardless of registration order**, and its own comment
says so (`knowledge-routes.ts:237-239`: "Hono itself resolves a static path ahead of a param one
regardless of registration order ... this is for readability, not correctness"). A `Set` has
neither an order nor that rule, so the matcher has to re-create it explicitly.
**CORRECTED 2026-08-06, the anchors, verified moved:** these three registrations were cited as
`knowledge-routes.ts:69,75,96` and the Hono comment as `:92-95`. Both ranges are now something
else entirely and a reader following them would have concluded the evidence did not exist: `:67-74`
is `EMPTY_KNOWLEDGE_RESPONSE`, `:76-84` is `knowledgeSearchQuerySchema`, and `:86-95` is the
proposal-NDJSON comment block ending at `const PROPOSAL_FILE_SUFFIX` on `:95`. The registrations
are `.get('/knowledge')` at `:150`, `.get('/knowledge/search')` at `:164`,
`.get('/knowledge/proposals')` at `:186` and `.get('/knowledge/:id')` at `:240`, with the
static-beats-param comment at `:237-239`. The claim is unchanged; only its evidence moved.

**3. Why this closes rather than merely shrinks: exactly one admissible spelling per operation.**

> **CORRECTED 2026-08-06.** This requirement previously argued the closure the other way round:
> "The only variable prefix cezar's route table has is `/p/<id>`, and the canonicaliser deletes it
> before any comparison, so the alias set collapses to one string **by construction** rather than
> by enumeration." Collapsing the aliases onto one key made every alias **admissible**, which is
> the bypass corrected above. The closure argument is now "one spelling is admissible", not
> "aliases collapse to one key".

**The rule.** For every operation there is exactly one admissible spelling, the unscoped
`/api/v1/<path>`. **If segment 3 of `url.pathname` is the literal `p`, the command is rejected
unconditionally with `refused_project_scope`, before segment 4 is validated, for every route
family, whether or not a handler exists under the scoped mount, and regardless of whether segment
4 is `default`, the boot project's id, or a registered project id.** Registering a project cannot
add an admissible spelling; adding a route cannot add one either, because a new route inherits the
same two mounts and the same rejection. **CORRECTED 2026-08-06: this read "segment 3 of the raw
path", which the backslash case in canonicaliser rule (b2) evades** (`/api/v1\p\proj9\knowledge`
has no third raw segment and parses to `/api/v1/p/proj9/knowledge`). Read `url.pathname`, and
reject a raw path that does not survive parsing byte-identically, which is rule (b2).

**The rule must cover both route families, and they fail differently.** This is the part an
enumerated fix gets wrong, because only half the surface looks scoped:

- **Double-mounted families.** `knowledgeRoutes` and `sourcesRoutes` are registered on `v1`
  (`server.ts:5124-5125`), which is mounted at both `V1_SCOPED_PREFIX` and `V1_PREFIX`
  (`:5155-5156`). `GET /api/v1/p/<id>/knowledge` matches a real handler.
- **Single-mount workspace families.** `notesRoutes` (`notes-routes.ts:41-70`),
  `workspaceRunsRoutes` and `notificationsRoutes` are on `workspaceV1` (`server.ts:5129-5142`),
  mounted **once**, at `V1_PREFIX` (`:5157`). There is no such thing as
  `POST /api/v1/p/<id>/workspace/notes` as a handler. **It is still dangerous**, because it still
  matches the `ALL /api/v1/p/:projectId/*` middleware, and Hono composes matched middleware and
  terminates with `notFoundHandler` (`hono-base.js:290-303`), so the resolver runs in full on the way
  to a 404. Four of phase 1's six allowlistable keys are in this family, so a rule that only
  considers routes with a scoped handler covers a third of the surface and reads as complete.

**The same middleware-composition fact falsifies a comment in cezar's own `server.ts`, and the
comment is the reason a reader would trust the wrong mechanism.** `server.ts:5150-5153` says
"Workspace families mount LAST and that is load-bearing: mounting the project table also mounts
its `use('*')` scope resolver over the whole prefix, and Hono runs matched middleware in
registration order. `/health` in particular ... must not sit behind the resolver." **Mount order
does not do that.** `app.route(V1_PREFIX, v1)` (`:5156`) registers `v1`'s `use('*',
resolveProjectScope)` (`:5107`) as `ALL /api/v1/*`, and `/api/v1/health` matches `/api/v1/*`
whatever is mounted after it, so the resolver **does** run on every health request. The conclusion
is still right and health is still safe, for a different reason: on the unscoped mount
`c.req.param('projectId')` is `undefined`, and `resolveProjectScope` short-circuits that case to
`bootContext` and calls `next()` without touching `contexts` (`server.ts:1367-1371`). That is the
same "harmless only by a runtime property the canonicaliser cannot see" shape as `default` and
`<bootId>`, and it is why this spec's own rule is unconditional rather than resting on it. Correct
the reason in that comment, keep its conclusion; the edit is in the TODO block, because
`server.ts` is not this spec's to touch.

**The property test must be able to see both families, and today's helper structurally cannot.**
`projectRouteManifest(app)` (`server.ts:388-401`) skips any route not starting with
`${V1_SCOPED_PREFIX}/`, so `workspaceV1`'s routes are invisible to it and the single-mount case
can never appear in a property driven from it. A control that cannot observe half its input scores
clean on that half forever. Replace it with:

```ts
// v1RouteManifest(app): every method+path under EITHER v1 prefix, deduped, method 'ALL' skipped.
// `scoped` is true when the same method+path also appears under V1_SCOPED_PREFIX.
{ method: string; path: string; scoped: boolean }[]
```

**Property.** For every manifest entry:

  a. `canonicalise(method, '/api/v1' + path).key === method + ' /api/v1' + path` (the one
     admissible spelling is admitted, so a canonicaliser that refuses everything cannot pass);
  b. `canonicalise(method, '/api/v1/p/' + id + path)` **rejects**, for
     `id in {default, <bootId>, <otherRegisteredProjectId>}`, and for `scoped` both true and
     false.

**Plus the trigger guard, without which the property scores clean on a corpse.** Assert that the
manifest yields **at least one `scoped: false` entry and at least one `scoped: true` entry**, and
fail the test if either bucket is empty. A manifest builder that silently reverts to the old
scoped-prefix-only filter empties the `scoped: false` bucket, and (b) then passes over an input
set that no longer contains the case it exists for.

**4. Check in both directions.** The platform refuses to enqueue a key its own catalogue does not
name, and cezar refuses to replay a key its own allowlist does not name. A compromise of
either side alone is then insufficient, and this is the only control in the entire design that
survives a full platform compromise (see Authorization). **The `/p/` rule is a both-directions
rule too**: `enqueueCommand()` refuses any `path` containing a `/p/` segment before it writes a
queue row, so the property holds from both ends rather than resting on cezar alone.

#### The one notation, and the compiled-in allowlistable set

**SUPERSEDED 2026-08-06 by this section: the hardcoded path denylist is gone.** The earlier draft
put a non-configurable denylist (`POST /api/v1/runs`, `/open-in-cli`, `/open-in-app`,
`/projects/checkout`, `/fs/browse`, "every `/notifications/transports*` mutator") **above** a
default-empty allowlist. It bought exactly one property worth keeping, that
`POST /api/v1/runs` is "unreachable by configuration rather than merely absent from a list", and
it paid for that with a second notation which was already wrong in three ways: it used a glob
(`transports*`), a prefix (`any /open-in-cli`), an English quantifier ("every ... mutator"), and it
named `/open-in-app`, a route that does not exist (the route is `/runs/:id/open-in`). Two notations
that disagree are a hole, not belt and braces.

**Keep the property, change the mechanism.** `CEZ_CMD_ALLOWLISTABLE` is a compiled-in `Set` of
canonical keys, the upper bound on what any configuration may ever name. Phase 1's set is exactly
six keys:

```
GET  /api/v1/workspace/runs
GET  /api/v1/workspace/notes
GET  /api/v1/workspace/notes/:*
GET  /api/v1/knowledge
GET  /api/v1/knowledge/search
POST /api/v1/workspace/notes
```

**`GET /api/v1/knowledge/:*` is deliberately absent, and the reason generalises.** A parameter key
matches every literal sibling at the same depth, so admitting it would silently admit
`GET /api/v1/knowledge/proposals` (`knowledge-routes.ts:186`; **CORRECTED 2026-08-06**, this was
cited as `:75`, which is now a blank line inside `EMPTY_KNOWLEDGE_RESPONSE`'s neighbourhood, see
the anchor correction under requirement 2), the read half of the apply flow,
which phase 1 does not ship. **Rule: never add a `:*` key while an unshipped literal sibling
exists at the same segment depth.** `GET /api/v1/workspace/notes/:*` passes that test because the
only GET at that depth is the note detail route itself (`notes-routes.ts:51`); the siblings that
would be dangerous (`/approve`, `/process`, `/reject`) are one segment deeper and are POSTs, so
they fail both the method check and the segment count.

**Two of these six keys are query-driven, and that is why the key is pathname-only.**
`GET /api/v1/knowledge/search` without `?q=` searches the empty string, and
`GET /api/v1/workspace/notes` without `?status` / `?projects` / `?limit` returns the unfiltered
list: both answer 200, so keying the query into the allowlist did not break them loudly, it made
them answer the wrong question. See canonicaliser rule (e). A key never contains `?`, `#` or a
query string in any of the four places the notation is used, and a config entry that carries one
is refused at load like any other key outside `CEZ_CMD_ALLOWLISTABLE`.

It is enforced **twice**: at config load, where a config naming any key outside the set is refused
loudly as a whole and the effective allowlist stays `[]`; and again at replay, where a claimed
command whose key is outside the set is refused with `refused_not_allowlistable` even if the
in-memory allowlist somehow contains it. Default-deny at both layers, closed over a growing route
table by default, one list, one notation.

**The one notation**, used in the tier table, the config file, the platform catalogue and this
set, with no second spelling anywhere: `"<METHOD> <canonical-path>"`. METHOD uppercase. The path
begins `/api/v1/` and **never contains `/p/`**. **CORRECTED 2026-08-06: that invariant now binds
the request, not only the config.** It previously read "never contains `/p/`, because
canonicalisation erased it", which was true of every configured key and false of every claimed
path. A `/p/` path is now refused rather than rewritten, so the notation and the wire agree: a
path containing `/p/` is not a badly spelled key, it is a rejected command. No globs, no
bare paths, no prefixes, no English quantifiers, **and no query string**: a key is a method plus a
pathname, and a `?` in a key is a malformed key rather than a narrower one. A parameter is the
literal token `:*` occupying exactly one segment, matched segment-count-exact.

Phase 1's configured allowlist is the read keys plus one write: `POST /api/v1/workspace/notes`.
`POST /api/v1/runs` is not in it and is not addable, because it is not in
`CEZ_CMD_ALLOWLISTABLE`, so a mis-typed config is refused at load rather than partially applied.

### Grafts from the losing candidates, named

Three ideas below are taken from designs this spec rejects. They are called out so that nobody
reads the Risks section and concludes the whole of a losing candidate was discarded.

**Graft 1, from the WebSocket candidate: the `commandId` is derived, never random.**
`chat/domains/chatbots/worker/src/runtime/scheduling.ts:100` sets `MAX_RETRIES = 5` and `:575`
increments `retry_count` on every drain, so a failed turn **re-executes its tools up to five
times**. A tool that mints `crypto.randomUUID()` per call files five notes for one text. This was
the single most valuable sentence in that candidate and it applies to every transport, including
this one. Two corrections to how the earlier draft of this paragraph proposed to derive it:

**CORRECTED 2026-08-06, the derivation is content-keyed, not ordinal-keyed.** The draft said
`HMAC-SHA256(COMMAND_ID_KEY, inboundEventId + ':' + toolCallOrdinal)`. **`toolCallOrdinal` is
model output**: the prompt is rebuilt on every attempt and each retry re-runs inference, so two
attempts on the same message can emit the same tool calls in a different order, and a dedupe key
must never be keyed on model output. Key on content instead:

```
commandId = 'cmd_' + base32(SHA-256(agentId | eventId | canonicalJSON({method, path, body})))
                       .slice(0, 26)   // RFC 4648 base32, upper case, no padding.
                                       // 26 chars = 130 bits. Written as .slice(0, 26) and not
                                       // [0..25], which reads as 26 to one reader and 25 to a
                                       // JS implementer.
eventId   = payload.event_id   (imsg-webhook.ts)
```

**CORRECTED 2026-08-06 (residual pass 4): `body` in that formula is the body BEFORE `sourceRef` is
written into it, and without this sentence the derivation does not terminate.** The T1 body this
spec publishes is `{body, source, sourceRef}` with `sourceRef` equal to the `cmd_*` the formula is
computing (Data Models, and the `bodyRaw` line of the claim contract, where the id appears inside
the very string that is supposed to produce it). Hashing the completed body would need the id it
returns. The order is: the tool composes `{body: <text>, source: 'api'}`; the id is derived over
**that** object; `sourceRef` is then set to the id; and the completed object is serialised **once**
into `body_json`, which is what is signed as `bodyRaw` and replayed verbatim. Determinism is
unaffected, because the pre-injection object is a pure function of the tool's arguments, which is
exactly what the retry collapse needs. Nothing downstream re-derives the id from `bodyRaw`, and
nothing may: cezar hashes `bodyRaw` for the MAC and never for identity.

Every `cmd_*` literal in this spec is the same 26-character value,
`cmd_QK7T2ZMB4XW3RJVN6DF5CAHS2P`, so a reader can never take the length of an example as a second
specification. (`lse_*`, `rcp_*` and `ccm_<uuid7>` are server-minted with no derivation claimed
here, so they keep their illustrative shapes.)

Two identical notes in one message therefore collapse into one command, deliberately. Say so in
the tool's acknowledgement rather than letting the owner discover it. `toolCallOrdinal` is still
**recorded** on the audit row for forensics; it is simply not an input to the id.

**CORRECTED 2026-08-06, `COMMAND_ID_KEY` is deleted and must not be reintroduced.** It appeared
once, in the formula above, and nowhere else: not in `command-source.json`, not in the section-6
defaults, not in the fail-closed layer, not within `SECRET_NAME_RE`'s reach (which governs cezar's
environment, while this would have been a chat-side worker secret cezar never sees). Its stated
job was determinism, which needs a deterministic function and not a secret. Unguessability bought
nothing, because `/ack` is bearer plus `leaseId` gated, `/claim` hands the ids out, and
pre-poisoning an id requires already holding enqueue rights. And rotation would have re-derived
every future id, so a retry straddling a rotation would duplicate and the two-plane `cmd_*` join
would split. The design keeps exactly two secrets. If a keyed id is ever reintroduced it arrives
with a named `_KEY$` env var in `.env.example`, the section-6 "flag on, key missing, refuse to
start" rule, and a derive-once-then-store rule, which is the identity/dedupe split and makes the
key pointless.

**The insert must be idempotent, not merely collision-prone.** A bare `INSERT` throws `UNIQUE` on
attempts 2 through 5, and **the throw is itself what fails the turn**, so one success would feed
its own retry loop to the dead letter and the owner would get a failure notice for a note that was
filed. Specify it:

```sql
INSERT INTO cezar_command_queue (...) VALUES (...) ON CONFLICT(id) DO NOTHING RETURNING id;
```

Zero returned rows means duplicate, which means success. The tool returns the same in-code
acknowledgement with the same `cmd_*` on every attempt, never an error. **The audit table takes no
such clause**: five drains must produce five `cezar_commands` rows and one queue row (see the
audit trail below).

**Graft 2, from the WebSocket candidate: every command carries its own HMAC.** The envelope is
signed with `CEZ_CMD_SIGNING_KEY`, a second secret distinct from the bearer token. The verifier
already exists in shape at `chat/domains/chatbots/worker/src/webhook-verify.ts:10-47` (`t=,v1=`
HMAC-SHA256, constant-time compare). **Be precise about what this
buys, because it is easy to overclaim:** if both secrets live in the same Worker secret store, a
full platform compromise yields both. What it actually protects against is misconfiguration (a
wrong endpoint cannot command), anything that can reach the claim response without holding the
signing key, and it makes each command self-authenticating so it can be logged and audited after
the fact independently of the transport hop that carried it.

#### Signing and the two clocks

> **CORRECTED 2026-08-06: the signed tuple and the windowed value were two different clocks with
> nothing binding them, and the published example is refused by its own rule.** The earlier text
> read: signed "over the canonical `(commandId, method, path, body, tier, issuedAt)` with a
> plus-or-minus 5 minute window on `issuedAt`", citing the verifier at `webhook-verify.ts:10-47`
> as the shape. That verifier windows `t` from the header (`:27-28`) and signs
> `` `${timestamp}.${body}` `` (`:38`); this spec windowed `issuedAt` and signed a tuple that does
> not contain `t` at all. Nothing made them agree, so a valid MAC over a fresh `t` carried an
> arbitrary `issuedAt`, and vice versa. Measured on this spec's own published envelope:
> `t=1785938589` is `2026-08-05T14:03:09.000Z`, exactly 86400 s before its own
> `issuedAt: "2026-08-06T14:03:09.000Z"`, so the example command is `refused_signature` under the
> rule printed beside it. The tuple was also a *parsed* JSON member, which the cited verifier
> never signs: it signs the raw body string it received, and a claim-response array element has no
> canonical serialisation cezar can reproduce byte-for-byte.

**One clock, two renderings, bound by an assertion.**

- **`t`, unix seconds, is the only signed and windowed value.** It appears once, in the `sig`
  header, exactly as the cited verifier has it.
- **`issuedAt` is `t`'s display form**, produced by `sqlToIso(created_at)`. cezar **must** reject
  the command unless `Date.parse(issuedAt) === t * 1000`, checked **before** computing the MAC.
  D1's `datetime('now')` is second-precision (verified: `SELECT datetime('now')` returns
  `YYYY-MM-DD HH:MM:SS`, sqlite 3.54.0), so this equality is exact and never lossy.
- **The wire carries `bodyRaw: string`**, the verbatim `body_json` column text. cezar hashes
  `bodyRaw` and only then `JSON.parse`s it for the replay. Same discipline as the cited verifier,
  and it removes JSON canonicalisation from **this hop**, which is the hop where cezar cannot
  reproduce it. (`canonicalJSON` survives on the chat side, in the `commandId` derivation, where
  one implementation produces the value and nothing has to reproduce it byte-for-byte later.)
- **`expiresAtUnix` is a wire field of its own, `expires_at_unix: number`.** **CORRECTED
  2026-08-06: it was in the signed string and in no wire field, and its derivation appeared only
  inside a comment on an example** (`"expiresAt": "...", // = expiresAtUnix 1786025889`). An
  implementer had two ways to get it, `Math.floor(Date.parse(expiresAt) / 1000)` or a field that
  did not exist, and a derived-on-both-sides value in a MAC input is the same defect the two-clock
  correction above fixed for `issuedAt`: nothing binds the two renderings. So the claim response
  carries it explicitly, and cezar **must** reject the command unless
  `Date.parse(expiresAt) === expiresAtUnix * 1000`, checked **before** computing the MAC, exactly
  as it does for `issuedAt` against `t`. Both equalities are exact for the same reason: D1's
  `datetime('now')` is second-precision, so `sqlToIso()` always emits `.000`.

**The signed string**, one line, no nesting:

```
`${t}.${commandId}\n${method}\n${path}\n${tier}\n${expiresAtUnix}\n${bodyRaw}`
header:  sig: t=<unix seconds>,v1=<hex>
```

`path` here is the raw `path` field verbatim, query string and all, because the signature covers
what was sent rather than what cezar decided to match on. Canonicalisation happens after
verification (step 2 of the replay order), and it reads that same raw string.

**The window is one-sided plus a hard stop, and the symmetric plus-or-minus 5 minutes is deleted
from this hop.** Accept iff **`t <= now + 60`** (forward skew only) **and `now < expiresAtUnix`**.
`expiresAt` is in the signed tuple because it is now the past-side bound, which is why it must not
be forgeable. The symmetric window belongs to the webhook hop, whose Mac is awake by definition;
here it was actively wrong, because T1's TTL is 15 minutes (see Risks) while the window was 5, so
"claimed on wake within 15 minutes" (the real-device row 7) was unpassable. A spec must not refuse
its own acceptance test.

**Graft 3, from the tunnel candidate: terminate at the inert append and stop.** That candidate's
best paragraph was not about tunnels at all. It was the observation that a channel which can only
reach `POST /api/v1/workspace/notes` has a bounded worst case, because the store lives outside
every checkout and `approve` (the only creating path) stays human-gated in the cockpit. Phase 1
adopts that scope exactly.

**CORRECTED 2026-08-06: the scope survives, its justification does not.** The acceptance criterion
here previously read "a leaked credential's worst case must be spam in an inbox, not a shell",
resting on the claim that the appended note is inert. **The note is inert with respect to the
runtime and not with respect to the model.** A note's `body` and `sourceRef` both ride into the
note pass prompt, the notes spec confirms `process` runs a background agent call and that
proposals carry a free-text `task`, and this spec's own T2 warning already says a forged knowledge
document is stored prompt injection. A forged T1 note is the same object, one press earlier.
Restated:

> **A leaked credential's worst case must be text that cannot reach a runtime without two
> independent human presses in the cockpit, never a shell.**

If a phase ever fails that sentence, the phase is wrong. It is true of phase 1 for reasons that
must be named rather than assumed, and each name is an obligation T1 carries:

1. **`process` and `approve` stay T3** and are unreachable from text in every configuration this
   spec ships. That, not inertness, is why the criterion holds.
2. **`source: 'api'` notes render as untrusted-origin** in the cockpit inbox and on the review
   screen, with their `cmd_*` displayed. A reviewer must be able to see that a human did not type
   this.
3. **The note pass prompt fences the body as data**, with a verification control: a body
   instructing the pass to propose outside the catalog yields no such proposal, and the control
   fails when the fence is removed. The catalog constraint in the notes spec is a second
   independent bound on the same text.

### Ack means accepted, never finished

A claimed command is acked as soon as cezar has reserved its receipt and issued the replay. The
outcome arrives later, through SPEC-417's fan-out, as a second message. This is not a
preference, it is forced, for two independently verified reasons:

- **A blocking tool has no timeout.** `executeTool` in
  `@ai-sdk/provider-utils@4.0.19/dist/index.mjs:2671-2687` does `yield { type: "final", output:
  await result }` (the yield is at `:2685`) with no race against `options.abortSignal`. The signal
  is handed to the tool and never enforced by the SDK. So the belief that `llm_timeout_ms = 60000`
  bounds a tool is false; the only hard stop is the 15-minute DO alarm wall limit. **Pin the
  version before quoting the line number:** `pnpm-lock.yaml` resolves 4.0.5, 4.0.19 and 4.0.21 in
  this workspace, so confirm which one the chatbots worker actually resolves. The behaviour is the
  claim; the line number is only evidence for it.
- **A wedged turn silently eats the owner's next message.** `alarm()` is serialized per object,
  so a blocking tool wedges the conversation for its full duration, and any message that arrives
  during the block and is older than `STALENESS_MS = 2 * 60 * 1000` when the drain resumes
  (`scheduling.ts:101`, applied `:535`) is marked `'stale'` and dropped. Because
  `if (fresh.length === 0) continue` at `:547` short-circuits before the dead-letter branch, **no
  notice fires**. He texted twice, was answered once, and nothing explains the gap.

Consequently the tool returns immediately with a deterministic, in-code acknowledgement (the
`report_issue` pattern: `tools/report-issue.ts` sends its own localized confirmation and
`agent.ts:3848-3870` wires it, so the acknowledgement never depends on the model), and the
outcome is a second bubble a few seconds later.

**"About 100 ms" is a budget, not a measurement, and the code does not exist yet.**
**CORRECTED 2026-08-06: the conclusion survives, its derivation does not.** The derivation
previously read "the comparable is `report_issue`, whose own D1 write is `waitUntil`-deferred
(`tools/report-issue.ts:421-423`) and which returns without waiting on it". Both halves are wrong
at that citation. `report_issue` **awaits** its in-code confirmation send there
(`report-issue.ts:421-423` is `if (ctx.confirmFiled) { try { await ctx.confirmFiled(); ... }`),
and the deferred call is `ctx.waitUntil(createReportTicket(...))` at `:190-204`, which POSTs
**Notion** (`NOTION_API` at `:76`, the request at `:357`). `report_issue` has **no D1 write at
all**. So the precedent bounds the in-code send and says nothing whatever about a D1 `INSERT`.
Restated: this tool does one D1 `INSERT` plus one in-code send and makes no model round trip;
`report_issue` is a precedent for the send being awaited and cheap, and for a remote write being
deferred. Either defer the enqueue the same way (the ack text is byte-identical on every attempt,
so nothing in the reply depends on the insert's result) or drop the comparable. **The honest gate
is the negative control, not the number**: a tool that sleeps 90 s must not return the turn at
60 s, proving the bound does not exist, and the shipped tool must then be shown never to block.
Do not quote 100 ms as if it had been observed.

### Interval, and why 5 seconds

Request cost does not discriminate between any interval anyone would choose, and the number is
written here so the wrong trade cannot be made later by reflex. A 30-day month is 2,592,000
seconds. Workers Paid includes 10M requests, then $0.30/M. D1 includes 25 billion rows read, then
$0.001/M.

| interval | polls/month | Workers requests at the margin | D1 rows read (4/poll assumed, see below) | mean added latency |
|---|---|---|---|---|
| 1 s | 2,592,000 | $0.78 | 10.4M, 0.04% of included | 0.5 s |
| **5 s** | **518,400** | **$0.16** | **2.1M** | **2.5 s** |
| 30 s | 86,400 | $0.03 | 0.35M | 15 s |
| 300 s | 8,640 | $0.003 | 0.03M | 150 s |

**The "4 rows per poll" column is an assumption that measurement falsified, and the fix is an
index change.** `EXPLAIN QUERY PLAN` was run on this spec's own DDL and claim statement (sqlite
3.54.0). With `idx_ccq_claim(state, visible_at)` the subquery plans as
`SEARCH ... USING INDEX idx_ccq_claim (state=? AND visible_at<?)` **plus `USE TEMP B-TREE FOR
ORDER BY`**: every ready-and-visible row is read and sorted before `LIMIT` applies, so reads are
roughly 0 on an idle queue and unbounded under a backlog, never 4. **Change the index to
`idx_ccq_claim(state, created_at)`**, whose measured plan is a bare `SEARCH ... (state=?)` with no
temp b-tree, because the sort key then leads. `(state, visible_at, created_at)` does not help: an
inequality ahead of the sort key kills the ordered scan. Restated honestly, and derived rather
than assumed: an empty poll reads 1 `api_keys` row and 0 queue rows; a non-empty poll reads at
most `maxCommands` plus the rows the residual `visible_at` / `expires_at` filter rejects. The
column above is retained only because the cost conclusion is unchanged at any value in that range,
and the conclusion is what the table exists to support.

**Nothing is saved by going slower.** What the interval actually chooses is the grammar of the
exchange. The chat side already imposes a floor of 2.5 to 8 seconds before the turn even starts
(`DEBOUNCE_MS = 2500`, `MAX_BATCH_WAIT_MS = 8000`, `scheduling.ts:104,107`), and the typing
indicator starts at delivery rather than at receipt (`transport/imessage-delivery.ts:52-55`, the call at `:54`), so at
5 seconds the ack bubble and the outcome bubble read as one exchange. At 60 seconds the second
bubble arrives after the owner has moved on, in a thread with no reply threading to attach it to,
and it reads as a bug rather than a result. Pick 5 seconds, jittered plus or minus 20% so a
restart storm does not synchronise.

**Two cost traps, both of which cost more than the polls.**

- **Never stamp `last_poll_at` on every poll.** D1 writes cost roughly a thousand reads. Stated at
  the interval this spec actually chooses rather than at the one that makes the number look
  biggest: at 5 seconds that is 518,400 writes a month, $0.52 at $1.00 per million rows written,
  against $0.16 of polls. **The stamp costs 3.3x the polls it annotates**, which is the point, and
  both figures sit inside the included allowances (50M rows written, 10M requests), which is why
  this is a discipline rather than a bill. Read the stored value and write only when it is older
  than 60 seconds. Never write on an empty poll.
- **Never park a long poll in a Durable Object.** A DO with an in-flight request cannot
  hibernate, and one object pinned for a month at 128 MB is 2,592,000 x 0.128 = **331,776 GB-s,
  which is 83% of the account's entire included 400,000 GB-s**, for a single connection. If a
  long poll is ever wanted, it is held in the Worker, where HTTP-triggered invocations have no
  wall-clock limit and duration is not billed, capped at about 25 seconds to stay inside the
  runtime-update grace period.

### cezar grows its first unconditional timer, and that is a doctrine change

Every timer in cezar today is demand-driven or work-driven. The health publisher runs only while
a socket subscriber holds the topic and stops at zero, with a comment recording that it
**replaced** N tabs times 5-second HTTP polls (`server/server.ts:1595-1615`). The automation
scheduler sets a timeout only while an enabled definition exists
(`automations/scheduler.ts:195-205`). F4's sender is demand-driven and carries a negative control
that **must fail** if the demand-driven start is replaced by a fixed `setInterval`
(`2026-08-06-pluggable-notification-transports.md`, W2.5).

A receiver cannot be demand-driven. That is what a receiver is. So the poller cannot ride F4's
sender and must not be written as a transport instance; it gets its own timer. Three mitigations
keep the change honest and bounded, and the irony (cezar's own codebase documents replacing a
5-second poll with a push socket) belongs in the upstream PR description rather than being
discovered by a reviewer:

- The interval is `unref`'d, following the one existing exception, `RunManager`'s queue watchdog
  (`workflows/run.ts:540-541`, `QUEUE_WATCHDOG_MS = 60_000` at `:212`).
- It starts only when `CEZ_CMD === '1'` **and** a config file exists **and** an endpoint and a
  token resolve. Any one missing and no timer is created at all.
- Backoff on failure is `min(60s, 5s * 2^n)` with full jitter, resetting on a successfully
  authenticated poll. Neither existing curve may be inherited: automations use `min(6h, 60s *
  2^(n-1))` (`automations/scheduler.ts:127`) and F4 uses `min(15min, ...)`. On a **receive** loop
  backoff converts directly into user-visible latency, and the outage it protects against is
  exactly the one the owner will text about. A 401 or 403 is terminal: stop, log once loudly, do
  not retry a revoked credential forever.

---

## Architecture

```
  Mac (behind NAT, no inbound port)              Cloudflare estate
 +--------------------------------+
 | cezar                          |
 |  CEZ_CMD=1                     |   Bearer lok_*  (scope = cezar-cmd)
 |  poller  ---- every 5s ------------------------------------+
 |    |                           |                           |
 |    | verify sig                |                           v
 |    | canonicalise (REJECT /p/) |          +-------------------------------+
 |    |   key = url.pathname only |          | platform                      |
 |    | allowlist (default empty) |          |                               |
 |    | reserve receipt           |          |  POST /cezar/v1/commands/claim|
 |    v                           |          |  POST /cezar/v1/commands/:id/ack
 |  fetch http://127.0.0.1:4321   |          |    -> queue row leased->acked |
 |    POST /api/v1/workspace/notes|          |   auth -> scope -> lease      |
 |    (Host: 127.0.0.1, no Origin)|          |  cezar_command_queue (D1)     |
 |    -> 201, note in ~/.cezar    |          |  cezar_commands   (D1, audit) |
 +--------------------------------+          +---------------+---------------+
                                                             ^
                                                             | enqueue
                                             +---------------+---------------+
                                             | chatbots worker               |
                                             |  POST /webhook/imsg           |
                                             |   HMAC verified UNCONDITIONALLY
                                             |   service TYPED here, asserted
                                             |     in the capability module   |
                                             |   ChatAgent DO                |
                                             |    cezar-control capability   |
                                             |     sender allowlist (closed):
                                             |       (transport,address,svc) |
                                             |     tool: capture_note (T1)   |
                                             |     deterministic ack in code |
                                             +---------------+---------------+
                                                             |
                      outcome rides SPEC-417's route, through F4's notifier on this end
                      (W1.7/W1.8/W2.4/W2.5 + CEZ_NOTIFY=1 + the `loki` row, D23)
                                                             v
                                        POST /notify/v1/events -> fan-out -> phone
```

### Where the enqueue lives, and why it is a local capability module rather than MCP

The tool that enqueues runs inside `ChatAgentImpl`. It is registered as a **local capability
module** in `capabilities/registry.ts` plus one `agent_capabilities` grant row, following the
default-deny discipline that migration `0054_agent_capabilities.sql:15-17` states explicitly
("an agent with no rows here holds nothing. There is no fallback to `agents.product` in the
worker"). Not an MCP binding, for three reasons:

1. **A capability hook can gate a mutation; an MCP tool cannot.** The in-repo demonstration is the
   trading confirm: `insertPendingTrade` writes a durable pending row
   (`capabilities/trading/pending-trades.ts:64-86`) and the *runtime* performs the mutation after a
   pre-inference intercept (`capabilities/trading/runtime/trade-conversation.ts:782-786`, the
   `placePendingTrade.call(this, row, "typed", ...)` line; `:755-780` is the ambiguity guard, a
   different thing, cited separately under Confirmation). **Do not cite
   `capabilities/mail-inbox/prompt/irreversible-actions.ts` for this**, as an earlier draft did: it
   states the opposite mechanism, recording that the hook "runs *outside* an inference turn and has
   no MCP client", which is why mail *could not* copy the trading shape and degraded to doctrine.
   It is evidence that hooks and MCP clients do not meet, not evidence that a hook gates a mutator.
2. **MCP bypasses the check-fire filter** (`agent.ts:4194-4200`, the exemption is
   `!mcpToolNames.has(name)` at `:4197`), which would make a cezar
   mutator reachable from an unattended timer fire with no human in the thread at all.
3. **`buildTools` pays an MCP connect for every bound server before the model is called**
   (`agent.ts:3590-3618`). For one tool that is latency spent on nothing.

The module registers conditionally on configuration, following `reportIssueConfigured(this.env)`
at `agent.ts:3848`: with no command source configured, the tools are **not built into the toolset
at all**. The model cannot be tempted by a tool that is absent, and cannot claim to have done
something it had no tool for.

### The queue lives in platform D1, not in a Durable Object

Platform is where identity exists: `api_keys`, scopes, `validate-key`, and SPEC-417's
`notify_subscribers`. The claim is a single conditional write, never a SELECT followed by an
UPDATE, because D1 serialises writes at the primary but read replication means a read can be
stale, so a read-then-write claim is a race by construction:

```sql
UPDATE cezar_command_queue
   SET state = 'leased', lease_id = ?1,
       leased_until = datetime('now', ?2), attempts = attempts + 1
 WHERE id IN (SELECT id FROM cezar_command_queue
               WHERE state = 'ready'
                 AND visible_at <= datetime('now')
                 AND expires_at  > datetime('now')
               ORDER BY created_at, id LIMIT ?3)
RETURNING *;
```

`ORDER BY created_at, id` rather than `created_at` alone, because `datetime('now')` is
second-precision and two commands enqueued in the same second would otherwise have no defined
order. The index below carries `id` as its third column so the tiebreak costs nothing: measured
on this DDL (sqlite 3.54.0), `(state, created_at)` plus this ORDER BY adds `USE TEMP B-TREE FOR
LAST TERM OF ORDER BY`, and `(state, created_at, id)` plans as a bare `SEARCH ... (state=?)`.

**CORRECTED 2026-08-06: `delivery_no` was off by one, and the claim route reports `attempts - 1`,
not `attempts`.** `attempts` defaults to `0` and this statement writes `attempts + 1`, so
`RETURNING *` yields `1` on the very first delivery. The audit-trail section then defined
`delivery_no` as "`cezar_command_queue.attempts` at claim time", which made the first delivery
`delivery_no = 1` while the real-device matrix (row 3) asserts `delivery_no = 0`, and while the
`enqueued` audit row written before any claim carried `NULL`. `/ack`'s targeting clause
`command_id = ? AND delivery_no = ?` therefore matched nothing on the first ack, inserted a second
row, and control 26(a)'s "the same row reads `executed`" became unsatisfiable. Two halves, and
both are needed:

- **`enqueueCommand()` writes `delivery_no = 0`** on the `enqueued` audit row, not `NULL`. `NULL`
  survives only on rows that never enqueued at all (`refused_sender`, `refused_tier`,
  `refused_ratelimit`, `refused_killswitch`, `refused_channel_unhealthy`), which also carry
  `command_id IS NULL`, so they can never collide with an ack.
- **The claim route puts `attempts - 1` on the wire as `deliveryNo`**, and cezar echoes that value
  back on `/ack`. First delivery `0`, first redelivery `1`, second redelivery `2`. `attempts`
  stays the count it reads as; `delivery_no` stays the zero-based index the matrix asserts on.

**One more consequence, because five turn retries write five audit rows sharing one
`(command_id, delivery_no)`.** With the fix, drains 0 to 4 of one message each write an `enqueued`
row carrying `delivery_no = 0` and the same `command_id` (only drain 0's queue insert survives,
`ON CONFLICT DO NOTHING`), so `/ack`'s targeting clause matches five rows rather than one.
**`/ack` therefore targets `command_id = ? AND delivery_no = ?` `ORDER BY turn_retry_no LIMIT 1`**:
the lowest `turn_retry_no` is the drain whose insert actually created the queue row, so the row
that flips to `executed` is the row that describes the delivery that happened. The other four stay
`enqueued`, which is exactly what they were. Control 7's five rows and control 26(a)'s one flipped
row are then both true at once.

**No JS timestamp is ever bound into a D1 comparison, and that is a hard rule rather than a
style.** The earlier draft of this statement bound `?3` from the caller and compared it against
`visible_at` / `expires_at`, whose defaults are `datetime('now')`, and the two formats are not
comparable as strings. Verified in Node: `'2026-08-06 14:03:11' <= '2026-08-06T14:03:11Z'` is
**true** and the reverse is **false**, so with `expires_at` written SQL-style and `?3` bound from
`toISOString()`, `expires_at > ?3` is never true. The queue would return `200 {commands: []}`
forever, which this spec's own API contract documents as the normal case that must not be logged
as an error: a dead feature byte-identical to an idle queue, with no error channel to notice it.
The same mismatch kills the feature a second time in the other direction, on cezar's side:
`new Date('2026-08-06 14:03:11')` parses as **local time**, which on the dev Mac is a two-hour skew
against the `Date.parse(issuedAt) === t * 1000` assertion (and, before that assertion existed,
against the window on `issuedAt`), so every command would be
`refused_signature`. And a third time in ordering, because
`'...T14:03:11.000Z' > '...T14:03:11Z'` is false, so mixing `toISOString()` with hand-written
second-precision ISO breaks `ORDER BY created_at`.

The pin, in three parts:

1. **SQL space-format UTC is the only timestamp format stored in D1.** `visible_at`,
   `leased_until` and `expires_at` are written only via `datetime('now', ?)`. This is already the
   house rule in this estate: `auth/oauth.ts:70`, `magic-link.ts:70`, `otp.ts:102` and
   `oauth-session.ts:46` all compare `expires_at > datetime('now')` and set
   `datetime('now','+5 minutes')`.
2. **One converter, `sqlToIso()`, at the route boundary is the only place ISO-Z is produced**, and
   the signed envelope's `issuedAt` / `expiresAt` are that form, so cezar's `new Date()` is
   unambiguous. It emits milliseconds always, and they are always `.000` because D1's
   `datetime('now')` is second-precision (verified above). **CORRECTED 2026-08-06:** this bullet
   previously ended "so the string ordering of two converted values matches their chronological
   ordering", which is true but useless as stated, and negative control 18 was built on the useless
   reading. Two rows written in the same second are byte-identical after conversion, so ISO
   ordering cannot separate them and `ORDER BY created_at` needs a deterministic tiebreak on `id`.
   The property that survives is the one the format pin actually needs: **`sqlToIso()` never emits
   a second-precision string, so a converted value never mis-sorts against another converted
   value.**
3. A live instance of exactly this trap already exists in the estate and is worth citing when
   reviewing: `platform/src/routes/notify.ts:73` does
   `new Date(row.expires_at) < new Date()` against `api_keys.expires_at`
   (`0001_initial.sql:49`), which is stored SQL-style.

**The visibility timeout covers "hand it to cezar", never "cezar finished it".** 30 seconds. A
lease shorter than the job duplicates the work and a lease long enough for a job makes every
crash a multi-hour stall; the way out of that dilemma is that ack means accepted, so lease
duration is permanently decoupled from run duration.

**CORRECTED 2026-08-06: `leased` was a terminal state, and every claim about redelivery rested on
a transition nothing performed.** The `state` CHECK admits `leased`, the claim above reads only
`state = 'ready'`, and nothing in the earlier draft ever wrote `leased` back to `ready`. So a
lease that expired stayed expired, `/ack`'s documented 409 ("the lease expired and the command was
already redelivered") could not occur, "delivery is at-least-once by contract" was false, and the
whole `reserveReceipt` justification below described a failure the schema could not produce.
**CORRECTED again 2026-08-06: this said "two statements fix it" and it takes three.** The round
that added the reclaim repaired the state machine on one edge and left its mirror broken, which is
the shape worth naming: a machine repaired in one direction tends to be wrong in the other.
Statements 1 and 2 are **batched ahead of the claim, never folded into it**; statement 3 belongs to
`/ack`:

```sql
-- 1. reclaim an expired lease
UPDATE cezar_command_queue
   SET state = 'ready', lease_id = NULL, leased_until = NULL
 WHERE state = 'leased' AND leased_until <= datetime('now')
   AND expires_at > datetime('now') AND attempts < 3;

-- 2. expire what is past its TTL or out of attempts (this is the transition that writes the
--    outcome='expired' audit row and fires the loud notice the Risks table promises)
UPDATE cezar_command_queue
   SET state = 'expired'
 WHERE state IN ('ready','leased')
   AND (expires_at <= datetime('now') OR attempts >= 3);

-- 3. THE ACK TRANSITION. Runs inside POST /cezar/v1/commands/:id/ack, in the same statement
--    batch as the audit-row update, guarded on the lease so a stale ack cannot close a row that
--    has since been reclaimed and redelivered (that is the documented 409).
UPDATE cezar_command_queue
   SET state = 'acked', lease_id = NULL, leased_until = NULL
 WHERE id = ?1 AND state = 'leased' AND lease_id = ?2
RETURNING id;
```

**`acked` had no writer, and that is the same defect as `leased`, fixed in one direction only.**
`grep`ping this spec for the value found it exactly once, inside the `state` CHECK. Nothing ever
transitioned to it, so statement 1 reclaimed **every** command, including the ones cezar had
already executed and acked: a note captured at t+2s was re-readied at t+30s (`leased_until`),
claimed again, and replayed again, three deliveries in total before `attempts >= 3` sent it to
statement 2. Statement 2 then wrote an `outcome = 'expired'` audit row and fired the **loud expiry
notice** the Risks table promises, so the owner's reward for a command that worked was two
duplicate deliveries and a message saying it had expired. It also falsifies real-device row 3
about thirty seconds after that row is read: "one row, `outcome = 'executed'`" holds until the
first reclaim and then never again. The local `reserveReceipt` absorbed the duplicate *effect* on
the Mac, which is precisely why this would have been invisible in `notes.json` and visible only in
D1 and on the phone.

**Zero returned rows from statement 3 is the 409**, and it is now a state the schema can actually
reach. Every ack outcome transitions to `acked`, not only `executed`: a refusal is cezar's final
answer for that delivery, and redelivering a `refused_local_allowlist` would just produce the same
refusal on a timer. `acked` means "cezar answered", which is the same distinction as
"ack means accepted, never finished" one section above. Statement 1 never touches an `acked` row
(it reads `state = 'leased'`) and statement 2 never touches one either (it reads
`state IN ('ready','leased')`), so an acked row leaves the queue only through the retention sweep,
exactly as the DDL comment says.

**And the ack vocabulary needs one value it did not have: `duplicate_receipt`.** A redelivery that
does reach cezar legitimately (a genuine lease expiry during a partition) hits `reserveReceipt`,
which is first-wins and returns `undefined` on collision (`automations/store.ts:147-165`). Before
this value, cezar's only honest options were to ack `executed`, which is a claim about *this*
delivery that it did not perform, or `replay_error`, which would say the loopback failed when it
was never called. Neither is true, and the audit table exists to be true. So: receipt already
reserved means **no replay at all**, ack `duplicate_receipt`, `replayStatus: null`, and the
`receiptId` of the reservation that already existed. It is a lifecycle fact, not a refusal and not
an error, and it is the only ack value whose presence in the table means the reclaim/redelivery
path actually ran in production.

**Separation is evidence-backed, not stylistic.** Folding the reclaim into the claim by widening
its subquery to `state IN ('ready','leased')` reintroduces `USE TEMP B-TREE FOR ORDER BY`
(measured on this spec's own DDL, sqlite 3.54.0: the single-value `state=?` form plans as a bare
`SEARCH ... USING INDEX idx_ccq_claim (state=?)`, the `IN` form adds the temp b-tree), which is
exactly the plan the index change below exists to avoid. Both statements above plan as bare
`SEARCH ... (state=?)` and both write zero rows on an idle queue.

**A server-side lease is required and cezar's own lease primitive cannot substitute.** cezar's
lock is a filesystem lock, `openSync(path, 'wx', 0o600)` with a 10-minute staleness reclaim
(`packages/cezar/src/automations/store.ts:208-226`). That defends one machine. The realistic
two-process case here is a dev Mac and a VPS, which share no filesystem, so the file lease sees
nothing and only the queue can dedupe them. Take the file lease as well, so two cezar processes
sharing one `CEZ_HOME` never both drain.

**A lease is not idempotency and both are needed.** Delivery is at-least-once by contract: a
lease expiring during a network partition redelivers a command cezar already started. cezar
already owns the correct primitive and it is already tested. `reserveReceipt`
(`automations/store.ts:147-165`) is keyed on a composite, first-wins, returning `undefined` on
collision, written **before** the work starts; `reconcileAutomationReceipts`
(`automations/task-template.ts:83-99`) resolves an orphaned `reserved` receipt on restart into
`launch-error` with the text recording that cezar restarted before the work completed, and
offers an explicit retry rather than auto-retrying. Copy that shape verbatim, keyed on
`commandId`. The lease protects against concurrency; the receipt protects against redelivery;
they are different failures.

---

## Authorization

This is the load-bearing section. Everything above is networking.

### 0. The governing principle, and the gate that blocks all of it

**Authorize by the direction of the privilege change, because the sender claim is unprovable on
every transport.** Text may always *reduce* capability (stop, revoke, cancel). Text may never
*increase* it (grant, enable, register, configure). A forged "off" costs the owner an
inconvenience; a forged "on" costs him `bash -lc`. Those are not the same mistake and must not
sit on the same authorization footing.

**Blocking prerequisite: `imsg-webhook.ts:26-39` must verify unconditionally.** Until that `if
(signature)` has an `else` that returns 401, an anonymous POST to a public URL is
indistinguishable from the owner texting, and **no tier of this model is shippable, including
read-only**, because a spoofed POST reads the owner's repo activity. This is a one-line fix and
it lands before anything else in this spec. Note what this design does and does not do about it:
it does not create the hole and it does not fix it, but it makes it load-bearing, because an
unsigned POST would enqueue a command.

### 1. Sender verification, per transport

Every transport answers a different question from the one authorization needs. What is verified
is "who sent this HTTP request". What is needed is "who typed this". No transport bridges that
gap.

| Transport | Cryptographically proven | Merely asserted | Strength |
|---|---|---|---|
| **iMessage (today)** | nothing (`imsg-webhook.ts:26-39`) | everything: `sender_handle.handle`, `chat.id`, `chat.owner_handle` | **zero. Treat as anonymous internet input.** |
| **iMessage (after the fix)** | that `imsg-api` composed the body: HMAC-SHA256 over `${timestamp}.${body}`, 5-minute window, constant-time (`webhook-verify.ts:10-47`) | that the handle string corresponds to a human. It is whatever `imsg-agent` read out of `Messages.db` | **medium.** Transport-authenticated, identity vouched for by our own Mac |
| **Telegram** | that the caller holds `TELEGRAM_WEBHOOK_SECRET` (`telegram-webhook.ts:112-118`) | `msg.from.id`. Telegram vouches for it; we do not | **medium** |
| **WhatsApp** | that Meta signed the raw body with `WHATSAPP_APP_SECRET` (`whatsapp-webhook.ts:121-128`) | `msg.from` = `wa_id`, a phone number | **medium** |

Three consequences, each fatal to a different naive design:

**(a) iMessage-after-the-fix is not the strongest because Apple.** The HMAC covers the last hop
only. Everything upstream is a trust chain through a shared Mac mini running three agent accounts
that exposes an auth-free `/internal/*` dispatcher over a public tunnel hostname
(`imsg-agent/src/server/http-server.ts:242-313` has no auth branch;
`imsg-api/src/tunnel-proxy.ts:66-76` sends no credential, which proves no Access policy sits in
front). Anything that can write to `Messages.db` or reach that hostname is the owner as far as
this model can tell.

**(b) The runtime cannot tell an iMessage from an SMS.** `imsg-api` puts
`makeHandle(d.sender, isFromMe, service)` on the wire (`domains/messaging/imsg-api/src/webhooks/payload-builder.ts:162-166`), and
`service` is a top-level member of the message payload too (`:171`), so the fact is already on the
wire and always has been. chatbots types the field as `sender_handle: { handle: string }`
(`imsg-webhook.ts:52`) and never reads `service` on the message path, while the **poll** path
(`:96`) and the **location** path (`:195`) both declare it. A green-bubble SMS with a spoofed
sender lands in the same thread with the same handle and is indistinguishable.
**`service === "iMessage"` becomes a hard, typed precondition for any tier above T0.**

**CORRECTED 2026-08-06: this said the check is "a change to `imsg-webhook.ts` in the same commit
as the signature fix", and putting it there breaks two things.** The gate has two possible homes
and only one of them works.

- **The webhook is the wrong home.** A webhook-level refusal returns before the DO, so no turn
  runs, no tool is called, and no tier and no operation are ever known. Negative control 2 demands
  that an SMS payload with the allowlisted handle produce a `cezar_commands` row with
  `outcome = 'refused_sender'`, and `tier`, `operation` and `chat_id` are all `NOT NULL` in that
  table while all three are known only **inside** the tool call. So the control's pass state is
  unreachable: the mutation would flip an assertion that could never have been green. Worse, a
  refusal in `imsg-webhook.ts` changes inbound behaviour for **every product on that worker**
  (Beside, Predicts and Loki share `POST /webhook/imsg`), and negative control 17 would not catch
  it, because 17 compares assembled runtime config, golden prompt snapshots and `modulesFor()`,
  none of which observe a message that was dropped at the route.
- **The capability module is the right home, and the check is already spelled out there.**
  Consequence (c) below defines the sender allowlist as `(transport, address, service)` **triples**
  checked as a closed whitelist in both directions. `service` is the third member of that tuple, so
  an SMS from the allowlisted address simply fails the triple and is `refused_sender`, with the
  tier and the operation in hand because the tool call is what produced them. That is one gate, not
  two, and it needs no new outcome value.

So the split is: **P5.0b types and threads `service`, and refuses nothing.** It adds
`service: string` (and `sender_handle.service`) to the message-path payload type in
`imsg-webhook.ts` and carries it into `ReceiveMessageParams` so the DO can read it. That is a
typing change with no behavioural change for any product, which is why it can ride the same commit
as P5.0a. **P5.3 enforces it**, inside the `cezar-control` capability module, as the third member
of the sender triple. Verifying the HMAC while being unable to tell SMS from iMessage is still a
half-closed door; the door is just not in the webhook.

**(c) `ADMIN_HANDLES` is the wrong primitive to reuse.** `isAdminHandle` is a comma-split string
compare (`tools/plan.ts:222-231`) against a worker-global var whose own comment says a handle
added there is an admin in **all** products with no per-product scoping (`wrangler.jsonc:55-60`).
Reusing it would make a Beside billing admin a cezar dispatcher. The command source carries **its
own** allowlist of `(transport, address, service)` triples, checked as a closed whitelist in both
directions, with an unrecognised transport denying rather than falling through: the same
discipline SPEC-417 P4.3 imposes on key scopes.

**Design conclusion: no tier above inert-write may rest on the sender claim alone.** Build as if
the sender field is a lie, because on the highest-traffic transport it currently is one.

### 2. The capability ladder

Five tiers, ordered by **immediacy of effect**, which is deliberately not the same as blast
radius (see the T2 warning).

**Every operation below is written as a canonical key**, in the one notation defined under "The one
sharp edge of the replay shape": `<METHOD> <path>`, path beginning `/api/v1/`, `:*` for a
parameter segment. The earlier draft of this table used unprefixed paths (`GET /workspace/runs`), a
fourth notation that could not be checked against the config file, the platform catalogue or the
allowlistable set. **Families that also mount under `/api/v1/p/:projectId` are not listed twice.**
**CORRECTED 2026-08-06:** the reason previously given was "because canonicalisation erases that
prefix before any comparison; the twin is the same operation on a different repo and lands on the
same key by construction". That is now false and was the bypass: the twin does **not** land on the
same key, it is refused as a spelling (`refused_project_scope`). The table is unchanged, but the
reason is now "a `/p/` spelling is not an operation this table can name, because it is not
admissible at all".

| Tier | Definition | Named operations |
|---|---|---|
| **T0 READ** | no state change on any plane | `GET /api/v1/workspace/runs` (read-only by construction), `GET /api/v1/workspace/notes`, `GET /api/v1/workspace/notes/:*`, `GET /api/v1/knowledge`, `GET /api/v1/knowledge/search`, `GET /api/v1/knowledge/:*`, `GET /api/v1/knowledge/proposals`, `GET /api/v1/ops/tickets`, `GET /api/v1/ops/tickets/:*`, `GET /api/v1/ops/tickets/:*/comments`, `GET /api/v1/ops/leases`, `GET /api/v1/runs`, `GET /api/v1/runs/:*` |
| **T1 INERT WRITE** | creates a record nothing consumes automatically and no agent reads as authority | **`POST /api/v1/workspace/notes` and nothing else.** |
| **T2 DURABLE WRITE** | writes something a future agent run or a human decision reads as true | `POST /api/v1/ops/tickets`, `PATCH /api/v1/ops/tickets/:*`, `POST /api/v1/ops/tickets/:*/comments`, `POST /api/v1/knowledge`, `PUT /api/v1/knowledge/:*`, `DELETE /api/v1/knowledge/:*`, `POST /api/v1/knowledge/proposals/apply`, `POST /api/v1/sources/:*/documents/:*/adopt`, `POST /api/v1/workspace/notes/:*/reject`, `PATCH /api/v1/workspace/notes/:*`, `DELETE /api/v1/workspace/notes/:*` |
| **T3 DISPATCH** | causes a process to execute, spends money, or writes to a third party | `POST /api/v1/runs`, `POST /api/v1/todos/:*/start`, `POST /api/v1/workspace/notes/:*/approve`, `POST /api/v1/workspace/notes/:*/process` (creates nothing but spends a real agent turn on the machine-wide default account), `POST /api/v1/runs/:*/messages` (a prompt turn), `POST /api/v1/runs/:*/open-in-cli`, `POST /api/v1/runs/:*/open-in`, `POST /api/v1/projects/checkout`, `POST /api/v1/sources/:*/sync`, `POST /api/v1/knowledge/reindex`, `POST /api/v1/ops/sync` (pushes to a git remote), `POST /api/v1/ops/reconcile`, `POST /api/v1/workspace/notifications/transports/:*/test` |
| **T4 META** | changes who may do what, or where data goes | `PUT /api/v1/workspace/notifications`, `POST`/`PUT`/`DELETE /api/v1/workspace/notifications/transports/:*`, `POST /api/v1/sources`, `PUT`/`DELETE /api/v1/sources/:*`, `PUT /api/v1/ops/mirror`, `POST /api/v1/ops/tickets/:*/lease`, `POST /api/v1/ops/tickets/:*/lease/heartbeat`, `DELETE /api/v1/ops/tickets/:*/lease`, `PUT /api/v1/workspace/config`, any `CEZ_*` flag, and **any change to this authorization model's own state**: adding an allowlisted sender, raising a rate limit, registering a dispatch entry, re-enabling after a kill |

Three corrections this table makes to its own earlier draft, each of which a reader could have
carried away:

- **`list_runs` and `get_run` are gone from T0.** They are tool names, not paths, inherited from
  the SPEC-417 MCP clause this spec supersedes. A tier table keyed on operations cannot contain a
  tool name; the operations they map to are `GET /api/v1/runs` and `GET /api/v1/runs/:*`, which
  are listed.
- **`GET /knowledge/*` is gone.** A wildcard contradicts this spec's own "match exactly, never by
  prefix" rule four paragraphs earlier, and knowledge is not one surface: the collection, the
  search, the proposals list and a document by id are four operations with different tiers on the
  write side.
- **T1 no longer carries `PATCH`/`DELETE` of "a note this channel itself created".** That clause
  was not expressible and, worse, was not what it claimed. It is expressible in the notation
  (`PATCH /api/v1/workspace/notes/:*`), so notation was never the blocker. The blocker is that a
  method-plus-path matcher **cannot see ownership**: T1 was defined as a note *this channel
  created* while this table's own T2 row makes `PATCH` of a note it did not create T2, and cezar
  has no identity and by D2 must not learn one, so `source` and `sourceRef` are invisible to the
  matcher. The entry would have granted T2 while claiming T1. Edit-your-own-note returns later as
  a route-level `sourceRef` predicate inside the notes handler, which is T2 with a check, never an
  allowlist line.

The tier of an operation is a property of the operation, not of the configuration: nothing below
T0/T1 is shippable in phase 1, and the allowlistable set is the narrower compiled-in bound.

**The T2 warning that must not be lost: editing knowledge is dispatch on a delay.** The
`knowledge/` root is committable by design and is read as authority by every subsequent coding
run (PLAN dispatch clause 8 makes knowledge documents the deliberate exception to the gitignore
rule, because they are content). A forged knowledge document is a stored prompt injection that
converts into T3 execution the next time any agent runs. It sits in T2 because its *immediate*
effect is a file write, not because its eventual blast radius is small. So T2-knowledge carries
one constraint the other T2 operations do not: `supersede`, which rewrites frontmatter and the
H1, is **not reachable from text at all**; only `upsert` into a scope the source is allowlisted
for.

**T3 and T4 are not available over text in any configuration this spec ships.** T4 permanently.
T3 has exactly one door in principle, described below so it is designed rather than improvised,
and **phase 1 and phase 2 ship no T3 at all.**

**The one T3 door, for the record: pre-registered, parameter-bounded, veto-windowed.** Text may
not *describe* a dispatch. It may only *select* one from a set the owner registered in the
cockpit, out of band, over the same-origin-guarded surface that already exists. A dispatch entry
is `{entryId, projectSlug, workflowName, allowedParams, requiresVeto: true}`. The text supplies
`entryId` plus values that must satisfy `allowedParams`. Nothing about the run's prompt,
workflow, steps, model, `autonomous` or `worktree` comes from the message, and inline `steps`
(the `command` step that becomes `spawn('bash', ['-lc', ...])`) is **structurally unreachable**,
because the request body cezar receives has no field for it. That moves the decision from "who is
texting" (unprovable) to "what was pre-authorized" (provable, decided on a channel with real
auth). It is the same move `automations/task-template.ts:8-19` already makes with its hard
placeholder allowlist, and the same move the notes spec makes by putting `startRun` behind
`approve` rather than behind `create`.

**Where each tier executes matters as much as who may call it.**

- **The model may propose any tier. The model may execute only T0 and T1.** The model is
  downstream of attacker-controlled text (run titles, GitHub issue titles, knowledge documents
  read wholesale), so "the model chose to call it" is not an authorization decision.
- T2 and T3 are **runtime-executed after a deterministic pre-inference confirm**, which forces
  the local capability module and rules out MCP entirely.
- **cezar's own check is not an authorization model and must not pretend to be one.** cezar has
  no user, no instance id and no ACL, and by D2 must not learn what a handle is. cezar verifies
  exactly two things: the signature, and that the canonical key of the replayed request is on its
  own allowlist. Everything about *who* is decided on the Cloudflare plane, where identity exists.
  This is also why cezar cannot express T1's original "a note this channel itself created": a key
  is not an owner.

### 3. Confirmation

**The mechanical shape is copied from the one that works**, the trading confirm protocol:
`insertPendingTrade` writes a durable row with at most one live per conversation
(`capabilities/trading/pending-trades.ts:64-86`; `:50-57` is `getLiveTrade`, the reader), the next
inbound text is intercepted **before
inference** by `dispatchInboundText` (`agent.ts:1127-1132`, dispatched at `:6943`), and the
*runtime* performs the mutation. Four properties are load-bearing and all four are preserved:

1. Deterministic parse. No model in the decision path.
2. One live ticket per conversation, with an expiry.
3. Pre-inference interception, so an injection inside the turn cannot fabricate the
   confirmation.
4. The ambiguity guard: `trading/runtime/trade-conversation.ts:755-780` refuses a bare "yes" when
   the ticket is no longer the last word and re-presents it demanding a mark that can only mean
   this action.

**What a cezar confirmation looks like in the thread: the resolved effect, never the request,
plus a one-time code.**

```
cezar wants to write knowledge:
  beside / .ai/cezar/knowledge/pricing-decisions.md
  new file, 1.4 KB, overwrites nothing
  requested from iMessage +48664483225, signature verified
Reply CONFIRM 4821 within 10 minutes, or ignore.
```

Rendering the resolved effect matters because the attacker controls the request text and not the
resolution; a confirmation the owner cannot check is a rubber stamp by construction. The code
defeats the stale-yes ambiguity mechanically, defeats an accidental tapback, and makes the audit
row self-describing. **Do not accept a tapback for T2 and above**, unlike trading: a tapback
carries no code and is trivially replayable by a forged inbound.

**Why a same-channel confirmation is worth much less than it looks.** Three reasons, each fatal
to a different naive design:

1. **It adds zero bits against the threat it is deployed against.** In trading the adversary is
   the model's judgement and the user is trusted, so a confirm is a real control. Here the
   adversary is the sender claim. Someone who can forge one inbound message can forge two.
   Confirm-then-act over the same spoofable channel converts a one-request attack into a
   two-request attack, which is a speed bump measured in milliseconds.
2. **The requesting text and the confirming text can come from the same injection**, unless the
   decision is deterministic and pre-inference. Attacker-influenced content already in the thread
   can assert that confirmation already happened.
3. **Frequency is a security parameter.** A confirmation the owner sees ten times a day is a
   reflex, not a decision. This is the strongest argument for pre-registration over
   per-invocation confirmation: pre-registration is one careful decision made at a keyboard;
   per-invocation confirmation is many careless decisions made on a phone while walking.

So, stated precisely so the vocabulary stays honest:

- **T1**: no confirmation. Rate limit only.
- **T2**: confirmation **is** the grant. It is weak, and it is accepted only because T2's
  immediate effect is bounded and reversible (git history for knowledge and tickets, `adoptedAt`
  on a source object).
- **T3**: confirmation is **not** a grant. The grant came from cockpit pre-registration. What the
  thread carries is a **veto**: the request is announced on *every enabled transport*, armed for
  N minutes, and executes unless STOP arrives. An attacker who forges inbound cannot suppress
  outbound, so a forged dispatch becomes noisy and revocable rather than silent. Name that as
  detection, not as a grant.
- **T4**: confirmation is worthless. No amount of same-channel ceremony authorizes changing where
  notifications are sent, since the attacker who forged the request is precisely the party who
  benefits from redirecting the channel that would have reported it.

**A hard coupling falls out of the veto design: T2 and T3 fail closed when the outbound channel
is not proven healthy.** SPEC-417 already stores `last_error`, `last_error_at` and
`last_delivered_at` per `notify_targets` row and already names the muted-thread failure as
indistinguishable from success. A veto window on a channel you cannot prove is delivering is
theatre. Require at least two transports with `enabled = 1` and a successful delivery within the
last 24 hours, or T2 and above refuse.

**That gate makes T2 depend on SPEC-417 P4.8, and the dependency was missing from the phase
table.** SPEC-417 ships iMessage in release phase 1, Telegram in P4.8 and WhatsApp in P4.9. With
release phase 1 alone **exactly one transport exists**, so the two-transport requirement means T2
refuses forever, silently, and nothing in this spec's verification would have surfaced it: the
end-to-end preconditions require only iMessage enrolled and the matrix is T0/T1 throughout. **The
phase table was wrong, not the gate.** The gate exists because a muted single channel is
indistinguishable from success, which is the failure the whole veto design is built against. So
phase 2 depends on **SPEC-417 P4.8 (Telegram enrolled, `enabled = 1`)** in addition to F5, and the
P5 table carries that dependency.

If the owner declines that coupling, the only honest alternative is "one fresh transport for T2,
two for T3", shipped **with** an explicit note that T2's confirm then rides a channel whose mute
is undetectable. It is not a free relaxation and must not be taken as one.

### 4. Rate limits and the kill switch

**The existing limiter is not a security limiter.** `SlidingWindowCounter(60, 60_000)`
(`rate-limiter.ts:1-19`, instantiated `new SlidingWindowCounter(60, 60_000)` at `agent.ts:500`) is per-DO, in-memory, and its own docblock says it resets on
hibernation; it is applied per pending-message unit at `runtime/scheduling.ts:565-567`. A forged
inbound chooses `chat.id` freely, and each distinct id mints a fresh DO with a fresh budget. Any
limit that matters must be durable and keyed on something the attacker cannot vary. Budgets live
on `(agent_id, tier)` in `AgentIndex` (already the cross-conversation home) and are mirrored into
platform D1 so a DO wipe does not reset them.

| Tier | Rolling limit |
|---|---|
| T0 | 60/hour |
| T1 | 20/hour, 60/day |
| T2 | 5/hour, 15/day |
| T3 | 3/day, minimum 5 minutes between arm events |
| T4 | 0, unconditionally |

**Two limits that are detection rather than throttling, and they matter more than the numbers
above:**

- **Distinct-conversation limit.** More than two distinct `chat_id`s attempting a T1-or-above
  command against `agt_cezar` within an hour **trips the kill switch automatically**, rather than
  returning 429. The real owner has one thread per transport; a spoofer cannot know the real
  `chat_id` and will mint new ones. This is the control that actually catches the forged-inbound
  attack, and it works precisely because the limiter counts something the attacker cannot
  observe. **It trips the same switch the in-thread `CEZAR STOP` trips, and therefore needs the
  same reset**, which nothing built until 2026-08-06: see "The reset, which nothing built" below.
  An automatic trip with no reset is a self-inflicted permanent outage, which is the failure mode
  this same list rejects one bullet down for the unsigned path.
- **An unsigned request on the command path pages immediately, at any rate, and must never trip
  the kill switch.** One is an incident, not a threshold. **CORRECTED 2026-08-06:** this rule
  previously read "`signature_verified = 0` on any T1-or-above request trips the kill switch and
  pages". Two things were wrong with it and both matter. First, it is an **auto-trip on an
  unauthenticated input**: any stranger with `curl` could permanently disable the owner's one-way
  control channel, turning the safety mechanism into the denial of service. An unauthenticated
  request pages, never trips. Second, post-P5.0a there is no `signature_verified = 0` row to key
  on, because an unsigned request is rejected before the body is parsed and never becomes an
  authenticated attempt (see the audit trail below); the signal now lives in the
  `cezar_unsigned_rejects` counter and its alert. **Auto-trip survives on exactly one control, the
  distinct-conversation limit above**, and it survives there precisely because that limiter counts
  something authenticated and something the attacker cannot observe.

Spend is bounded separately by SPEC-417's `agent_spend_limits.limit_cents = 500`.
`POST /api/v1/workspace/notes/:*/process` counts against the T3 budget despite creating nothing,
because it spends a real agent turn on the machine-wide default account.

**Kill switch: three independent layers, each sufficient alone, and none of them re-enables from
the phone.**

1. **In-thread, deterministic, pre-inference.** A whole-message `CEZAR STOP` (with localized
   equivalents, reusing `conversationLanguage()` the way the trading grammar does) intercepted in
   `dispatchInboundText` before the model sees the turn. It writes a disabled flag to
   `conversation_config` **and** to `AgentIndex`, so the kill is agent-wide rather than
   conversation-wide and one forged conversation cannot be used to keep the real one alive. It
   cancels every armed veto window. It is inbound-only, so it works on a muted thread. **It
   cannot re-enable from the thread**; re-enabling is a separate authenticated action, specified
   in "The reset, which nothing built" below. That asymmetry is the entire reason this layer can
   live on the weakest channel.
2. **Platform-side credential revocation.** Inbound uses its **own** `lok_*` key with its own
   scope, separate from SPEC-417's `notify` scope, so revoking commands leaves notifications
   alive. That is deliberate: you want the outbound channel reporting while the inbound channel
   is dead, because that is how the attack gets watched. Revocation is one DELETE: the internal
   validator distinguishes a revoked key at `platform/src/routes/internal.ts:48-49` (`:47` is the
   404 for an unknown key, a distinction this design deliberately does **not** inherit, see the
   claim contract), and it is reachable from the phone's browser, so it works even when iMessage
   itself is the compromised channel.
3. **cezar-side, fail-closed.** `CEZ_CMD` must be exactly `'1'`; with the flag on but no token or
   no signing key configured, the poller **refuses to start** and logs one line, on the
   `orderRelayFork()` precedent that returns `null` rather than dialling an unauthenticated
   origin (`chat/domains/predicts/trading/src/lib/polymarket/gateway.ts:195-209`). Plus a flag
   file under `~/.cezar/` consulted per tick, so `cezar cmd off` kills it without an env edit and
   a restart.

**STOP does not kill a run already executing.** cezar cannot safely interrupt a mid-edit agent.
STOP is recorded, armed dispatches are cancelled, and the cockpit surfaces the in-flight run. Say
that plainly rather than implying a stop button that does not exist.

**The reset, which nothing built. ADDED 2026-08-06.** Three places said re-enabling is "a cockpit
action" (layer 1 above, the claim contract's 403 row, and real-device rows 8b and 9b) and **no work
package shipped a reset at all.** P5.3 ships the write side only: "kill-switch state in `AgentIndex`
**and its platform-D1 mirror**". Nothing clears either. That is not a documentation gap, it is
three unrunnable device rows and a channel that dies permanently on its first trip:

- **"The cockpit" cannot mean cezar's cockpit.** cezar's cockpit is the React app its own server
  serves on `127.0.0.1:4321`; it talks to cezar's `/api/v1/*` and holds no Loki credential. By D2
  it must not learn one, and negative control 15 greps `packages/cezar/src/` for `loki` and fails
  the build if it appears. It can reach neither `AgentIndex` nor platform D1, ever.
- **Clearing the mirror by hand is worse than doing nothing.** `wrangler d1 execute ... UPDATE
  cezar_kill_switch SET disabled = 0` makes `/claim` stop answering 403, so the poller comes back
  and looks healthy, while the authoritative `AgentIndex` flag is still set and every enqueue still
  answers `refused_killswitch`. A working poller in front of a dead channel is the confusing state,
  not the safe one.
- **One-way-forever is not an option here, because the auto-trip exists.** The distinct-conversation
  limit trips the switch automatically on **authenticated** traffic, and this section already
  rejected an auto-trip on unauthenticated input precisely because "the safety mechanism becomes
  the denial of service". A trip with no reset is that same failure with a slower fuse.

**So a package builds it, and it clears both planes in one operation, DO first.**
`POST /admin/cezar/kill-switch/clear` on platform, behind the existing super-admin gate
(`domains/platform/src/routes/admin.ts:15`, `admin.use("*", localJwtAuth(), superAdmin())`, the
`superAdmin()` middleware at `packages/auth/src/middleware.ts:118`), which is reachable from the
phone's browser for the same reason revocation is, and is a channel with real auth rather than the
one that was forged. It does two things in this order:

1. `POST /internal/agents/:agentId/cezar-kill-switch { disabled: 0 }` on the chatbots worker,
   which clears the flag in `AgentIndex` and in every `conversation_config` row. That route rides
   the existing `X-Internal-Secret` gate (`routes/internal-admin.ts:38-44`) and the existing
   `AgentIndex.idFromName('agent-index:' + agentId)` shape (`:148-149`), so it adds a handler and
   no new auth surface. It is the authoritative write because `AgentIndex` is a **chatbots** DO
   (`agent-index.ts:51`) and platform's only DO binding is `MCP_AGENT`
   (`domains/platform/wrangler.toml:9-11`, `:73-75`), which is the same fact that forced the mirror
   to exist in the first place.
2. Only on a 2xx from step 1, `UPDATE cezar_kill_switch SET disabled = 0, reason = NULL` on
   platform D1.

**The order is the fail-closed direction and must not be flipped.** DO cleared but mirror write
failed leaves the mirror engaged, so `/claim` keeps answering 403 and the channel stays off, which
is safe and visible. Mirror cleared but DO clear failed is the confusing state above. Negative
control 10 mutation D is the control on it.

It does **not** restart the poller. 403 is terminal by design (see the claim contract), so the
operator restarts cezar as a second, deliberate step, and rows 8b and 9b say so.

### 5. The audit trail

"Did a text cause this?" must be a join over two tables on two planes, with no log parsing, and
it must be answerable when the Mac has been compromised.

**cezar side: extend, never rename.** cezar is a released npm package. Phase 1 creates no runs,
so nothing is added to `RunRecord` at all: the provenance a note carries is the existing
`source: 'api'` plus `sourceRef` (see Data Models). The optional `origin` object on `RunRecord`
is deferred to whichever phase first creates a run, and it is additive when it arrives.

**Receipt before effect, reconciled on restart.** Reserve the receipt, take the single-writer
lease, replay, mark launched. On boot, reconciliation turns an orphaned `reserved` receipt into
an error state with a stated reason and an explicit retry, exactly as
`reconcileAutomationReceipts` does (`automations/task-template.ts:83-99`). A crash mid-command
becomes a recorded state rather than a gap, which is the difference between an audit trail and a
story.

**Platform side: one `cezar_commands` row per *authenticated* inbound attempt, successes and
refusals alike.** A table that records only successes cannot show an attack in progress.

**CORRECTED 2026-08-06: "every refusal" is narrowed to "every authenticated refusal", and
`signature_verified` is no longer the most important column.** The earlier draft said "one row per
inbound attempt, successes and refusals alike" and called `signature_verified` "the single most
important column in this design". Both were made false by this spec's own P5.0a. P5.0a makes the
signature check unconditional and returns **401 before `JSON.parse(rawBody)`**, so at refusal time
there is no `event_id`, no `sender_handle`, no `chat.id` and no tier: every `NOT NULL` column in
the table below is unavailable. And post-P5.0a `signature_verified` is a constant on every row
that exists, which is no signal at all.

The two rules collided, and **"reject unsigned before parsing" wins**. `cezar_commands` becomes a
**post-authentication table**, enforced structurally rather than by convention:

```sql
signature_verified INTEGER NOT NULL CHECK (signature_verified = 1)
```

The pre-authentication path stores **nothing attacker-controlled**: one counter row in
`cezar_unsigned_rejects(route, bucket_minute, count)`, keyed on the server clock only, upserted
after the 401, plus a rate-limited page over the SPEC-417 fan-out.

**The cost, stated plainly rather than dressed up.** For unsigned traffic we lose per-attempt
attribution permanently: which handle was claimed, which `chat_id`, the text, the intended tier.
That is a real loss and it is the right one, because those fields come from an unverified body and
writing them as audit facts would be **fabricated evidence** in the one table an incident is
reconstructed from. What survives is count, timing and route, which is what the alert needs. The
detection `signature_verified` was meant to carry now lives in the counter and its page.

**One row per attempt means five rows for five retries, and "attempt" is two different axes.**
`MAX_RETRIES = 5` (`scheduling.ts:100`) with `retry_count` incremented per drain (`:575`) means one
message can be drained five times: that is `turn_retry_no`, 0 to 4. Redelivery from the queue is a
second, independent axis: that is `delivery_no`, **zero-based**: written as `0` by
`enqueueCommand()` and reported by the claim route as `attempts - 1`. **CORRECTED 2026-08-06: this
read "taken from `cezar_command_queue.attempts` at claim time", which is one too many**, because
`attempts = attempts + 1` in the claim makes the first delivery `1`, against a real-device row that
asserts `0` and an `enqueued` row that carried `NULL`. The derivation, its consequences and
`/ack`'s targeting rule are in "The queue lives in platform D1" above.
A single `attempt_no` column could not hold both, and naming it `retry_count` made it
unfillable on cezar's ack leg, which never sees a `retry_count` at all. The audit table must record
all five turn retries, so it takes **no** `ON CONFLICT DO NOTHING` clause and **no** `UNIQUE` on
`command_id`: its primary key is a fresh server-generated `ccm_*` per attempt. Retry collapse stays
exactly where it belongs, on `cezar_command_queue.id`'s first-wins primary key, which produces one
queue row and one note. Five audit rows and one queue row is the correct answer for a retried turn,
and the earlier draft's derivation
of the audit row id from `(eventId, toolCallOrdinal)` made it structurally impossible: it collapsed
five attempts into one row while the spec's own text demanded one row per attempt, and it was
undefined for every refusal outcome, none of which ever reaches a tool call.

**Both planes, never one.** cezar's local receipts alone sit on the machine an RCE compromises.
D1 alone proves what was asked, not what cezar did. The join on `commandId` is what makes the
pair evidential.

### 6. The default

**With no configuration at all, nothing exists.**

- cezar: `CEZ_CMD` unset means the command surface does not exist. No timer, no dial, no config
  read, no prompt bytes. `capabilities.command` reports `false` and the cockpit shows nothing.
- cezar: `CEZ_CMD=1` with no token or no signing key means **refuse to start the poller**, log
  one line, stay off. Never "poll unauthenticated".
- chatbots: no command source configured means the cezar tools are **not built into the toolset
  at all** (`reportIssueConfigured` precedent, `agent.ts:3848`).
- Sender allowlist: **empty, and empty means deny.** Not "empty means the owner". Checked in both
  directions; an unrecognised transport denies rather than falling through.

**With a source configured but nothing else: T0 only. Read-only.** **CORRECTED 2026-08-06
(residual pass 4): in phase 1 that state is configured and inert, not a working read-only channel.**
No tool emits a T0 read and no leg returns a read's answer, so "T0 only" means the channel exists
and can do nothing. See "Phase 1 ships one tool" under Phases. The ladder below is unchanged and is
what a later phase opts into.

- T1 requires an explicit per-source opt-in.
- T2 requires opt-in **plus** two enabled notify transports with a delivery in the last 24 hours,
  which is why phase 2 is blocked on SPEC-417 P4.8 as well as on F5: with release phase 1 alone
  only one transport exists and T2 refuses unconditionally.
- T3 requires opt-in plus at least one pre-registered dispatch entry, created only in the
  cockpit, and it is not implemented by any phase in this spec.
- T4 has no opt-in. There is no configuration that turns it on.

**Why this default and not the tempting one.** The tempting default is "if it is configured, the
owner's handle can do everything", because it is what was asked for and it is one line. It ships
a remote shell the moment one env var is set, because the sender claim on the highest-traffic
transport is currently unverified and, even once verified, is an assertion by a shared Mac that
already exposes an auth-free `/internal/*` over a public hostname. With T0 as the default the
worst outcome of a misconfiguration is an information leak. With T3 as the default the worst
outcome is `spawn('bash', ['-lc', command], { env: process.env })` with the owner's full
environment. **A working read-only channel can be turned up after a week of watching the audit
table. A run cannot be un-run.** (Turned up by **P5.6**, which this spec does not open: phase 1's
T0 keys are allowlistable and unreachable, per "Phase 1 ships one tool".)

---

## Phases

Nothing here re-derives a decision recorded in the PLAN. New package ids are prefixed `P5` to
keep them distinct from the PLAN's existing `P4.x` (SPEC-417) series; add them to the PLAN's
phase-4 table in the same session this spec lands.

### Phase 0: prerequisites. P5.0a, P5.0b and P5.0d blocking; P5.0c landed.

| id | repo | title | why it blocks |
|---|---|---|---|
| **P5.0a** | chat | Make the iMessage webhook signature check unconditional | Until then an anonymous POST is indistinguishable from the owner, so even T0 leaks. One line plus a test. |
| **P5.0b** | chat | **Type and thread** `service` on the inbound message path. Refuses nothing. | **CORRECTED 2026-08-06: this row read "Type and assert `service === "iMessage"`", and the assert does not belong here.** A refusal in `imsg-webhook.ts` returns before the DO, so no tier and no operation exist and negative control 2's row (whose `tier`, `operation` and `chat_id` are `NOT NULL`) can never be written, and it changes inbound behaviour for **every product on that worker** in a way control 17 does not observe. P5.0b adds `service: string` (and `sender_handle.service`) to the message-path payload type at `imsg-webhook.ts:45-64` and carries it into `ReceiveMessageParams`. The **assert** moves to P5.3, as the third member of the sender triple. `imsg-api` already puts `service` on the wire (`payload-builder.ts:171`) and the poll (`imsg-webhook.ts:96`) and location (`:195`) paths already declare it, so this is a typing change with no behavioural change. Still same commit as P5.0a. |
| **P5.0c** | chat | SPEC-417 **P4.3**, both directions | **LANDED 2026-08-06. Not blocking.** **CORRECTED 2026-08-06:** this row previously read "A new scope minted against imsg-api's fail-open classifier grants full org iMessage access. `key-scopes.ts` closes the mint side today; the read side is still open", and a reader could have scheduled work on it. P4.3 closed **both** directions: mint-time rejection at `domains/platform/src/routes/keys.ts:54-55` (`if (scope !== undefined && !isKeyScope(scope)) return c.json({error: ...}, 400)`), and a closed `Record<KeyScope, ...>` classifier at `domains/messaging/imsg-api/src/middleware/platform-auth.ts:146-196` (`classifyKeyScope` denies anything `isKeyScope` rejects). What is left is one line **inside P5.1**: add `cezar-cmd` to `KEY_SCOPES` (`chat/packages/types/src/key-scopes.ts:28`, `["admin", "account", "org", "notify"]`; **CORRECTED 2026-08-06**, this cited `:20-26`, which is the comment block recording the removal of the `line` scope, not the array) **and** to the classifier record, in the same commit, because the record is a closed `Record<KeyScope, ...>` and omitting the arm is a type error rather than a hole. |
| **P5.0d** | chat | Dead-letter notice for silently dropped stale inbound | `scheduling.ts:547` short-circuits before the dead-letter branch, so a message dropped at 120 s produces no reply and no notice. A command channel makes that indistinguishable from "the command was ignored". |

### Phase 1: T1 note capture. The shippable unit. (Was "T0 reads and T1 note capture" until 2026-08-06: T0 ships no tool and no return leg, see below.)

| id | repo | title | deps |
|---|---|---|---|
| **P5.1** | chat | platform: migration `0063_cezar_commands.sql` (`cezar_command_queue` + `cezar_commands` + `cezar_unsigned_rejects` + the mirrored kill-switch flag), `enqueueCommand()` including its `/p/` refusal **and its `delivery_no = 0` on the `enqueued` audit row**, the closed canonical-key catalogue, the shared outcome const, `sqlToIso()`, the reclaim / expire **and ack** statements, TTL and retention sweep, and the `cezar-cmd` scope added to `KEY_SCOPES` **and** the imsg-api classifier record in one commit | none |
| **P5.2** | chat | platform: `POST /cezar/v1/commands/claim` and `/:id/ack`, scope `cezar-cmd`, single-statement lease with `datetime('now')` inlined, **`deliveryNo = attempts - 1` on the wire**, **`expires_at_unix` on the wire**, `/ack`'s `leased -> acked` transition and its `ORDER BY turn_retry_no LIMIT 1` targeting, the collapsed opaque 401, **`POST /internal/cezar/commands` and `POST /internal/cezar/unsigned-reject` behind `X-Internal-Secret` (the chatbots-to-platform write hop, ADDED 2026-08-06: the chatbots worker has no D1 binding, so nothing else can write these tables)**, and the **mirrors** the claim route reads: the `(agent_id, tier)` budgets and the kill-switch flag. **CORRECTED 2026-08-06 (residual pass 4): this row read "per-tier rate limits, the distinct-conversation trip", which puts enforcement on the wrong plane.** Authorization section 4 keeps the budgets in `AgentIndex` and mirrors them, control 24 mutation A turns on the budget surviving a DO recreation, and control 11 mutation C turns on the trip being written to `AgentIndex` first and mirrored second. Enforcement is P5.3's; P5.2 owns the mirror and the 403 it produces. | P5.1 |
| **P5.3** | chat | chatbots: the `cezar-control` capability module. Sender allowlist **as `(transport, address, service)` triples, which is where the `service === "iMessage"` assert lives**, tier gate, content-derived `commandId`, `ON CONFLICT DO NOTHING` enqueue, in-code acknowledgement, `CEZAR STOP` pre-inference interception, kill-switch state in `AgentIndex` **and its platform-D1 mirror**, **`POST /internal/agents/:agentId/cezar-kill-switch` (the reset's authoritative write side) and its `GET` twin, which is the only way device row 8b can read the authoritative flag**, **the per-tier rate limits and the distinct-conversation trip (enforced here on `AgentIndex`, mirrored to platform D1 through `POST /internal/cezar/commands`)**, the unsigned-reject counter and its page | P5.0a, P5.0b, **P5.0d**, P5.2 |
| **P5.3b** | chat | platform: `POST /admin/cezar/kill-switch/clear` behind `localJwtAuth() + superAdmin()`, calling P5.3's internal route first and clearing the `cezar_kill_switch` mirror only on its 2xx. **ADDED 2026-08-06**: the kill switch had a write side and no reset, which made real-device rows 8b, 9 and 9b unrunnable and made any auto-trip a permanent outage. See "The reset, which nothing built". | P5.3 |
| **P5.4** | cezar | The poller: config store, canonicaliser (including the `url.pathname` byte-identity reject and the pathname-only key), allowlist, signature verify (including `Date.parse(expiresAt) === expiresAtUnix * 1000`), receipt, replay, ack, backoff, `CEZ_CMD` capability, `.env.example`, `BACKWARD_COMPATIBILITY.md` | P5.2, **W1.1**, **F4: W1.7, W1.8, W2.4, W2.5** (and W4.7 for `cez notify test`) |
| **P5.5** | both | Verification: negative controls, the real-device matrix, the audit-join query | P5.3, **P5.3b**, P5.4 |

**Phase 1 ships one tool, so T0 is allowlistable and unreachable. ADDED 2026-08-06 (residual pass
4).** The heading above says "T0 reads and T1 note capture" and the TLDR, the tier table and section
6's default ladder all read as though a read-only channel works. It does not, and nothing in three
rounds of correction noticed, because the gap is between two sections that each look complete:

- **No tool emits a read.** The only tool this spec ever names is `capture_note` (the architecture
  diagram, P5.3's contents, negative controls 2 and 23, and device row 5, which states it outright:
  "Phase 1 registers `capture_note` and nothing else"). A key that no tool can produce is never
  enqueued, so five of the six `CEZ_CMD_ALLOWLISTABLE` keys are unreachable from a text message.
- **No leg carries a read's answer back.** `/ack` carries `{commandId, deliveryNo, outcome,
  replayStatus, receiptId}` and the receipt carries `replayStatus`, both of which are an integer
  status and never a response body. The outcome bubble is composed by cezar and posted through F4,
  and by D2 cezar may not learn what a run list or a knowledge document means. So even a hand-minted
  T0 command would replay successfully, ack `executed`, and tell the owner nothing but "200".

**The decision, so an implementer does not have to make it mid-package: phase 1's shipped surface is
the T1 append, and T0 is deferred.** The six-key allowlistable set is unchanged, because it bounds
the **poller**, which is generic and is driven in negative controls 4, 5, 6 and 22 by synthetic
claimed commands that no tool ever produced. What phase 1 lacks is the emitter and the return leg,
not the bound. Two consequences to carry:

- The phase heading, the TLDR and section 6's "With a source configured but nothing else: T0 only.
  Read-only" all mean **configured and inert**: the channel exists, refuses nothing because nothing
  is asked, and captures no note until the T1 opt-in is set. That is still the right default (it is
  what device row 5 exercises, and what makes `refused_tier` have a phase-1 trigger), but it must
  not be read as a working read-only channel.
- A read surface is **P5.6, not opened by this spec**, and it needs both halves or neither: a tool
  whose only argument is a key chosen from a **closed enum** of T0 keys, never a free-text path (a
  free-text path hands the model the canonicaliser's input, which is the one string this design
  spends its whole security budget bounding); and a return leg that carries a bounded prefix of the
  replay's response body, which is a new field on `/ack` or on the receipt, a size cap, and a
  decision about putting cezar's own data into a notification. Until both exist, no heading in this
  spec may claim reads ship.

P5.4 is the only cezar-side package. It owns
`packages/cezar/src/command/{config,canonical,allowlist,poller,receipts}.ts` plus tests, one
capability line in `server/capabilities.ts`, and the two doc files.

**CORRECTED 2026-08-06: P5.4 does not exempt itself from D6, it requests a named exception.** The
earlier draft said P5.4 "creates **no route**, which is what keeps it out of the scaffold's
chokepoint files (`server.ts`, `BACKWARD_COMPATIBILITY.md` section 2, `typed-bodies.test.ts`) and
therefore out of a D6 collision". That is a non sequitur, and it is the exact shape of quiet
contradiction the PLAN's authority clause exists to prevent: **D6 is keyed on files, not on
routes.** Route-freedom clears `server.ts` and `typed-bodies.test.ts` and nothing else. W1.1 owns
`packages/cezar/src/server/capabilities.ts` and its test, `BACKWARD_COMPATIBILITY.md`,
`.env.example` and `packages/contract/src/health.ts`, and P5.4 needs four of those, because a
`command` capability boolean lands on `capabilitiesSchema` in `health.ts` (the same precedent the
notes spec follows). So P5.4 must be **granted** those files by a named PLAN exception, the way
D22(b) grants F5's, and it takes **W1.1 as a dependency**, which is what makes the grant safe: it
is then temporally separate from wave 1, so D6's actual purpose (never two concurrent agents in one
file) holds. **CORRECTED 2026-08-06: this ended "The exact PLAN text to add is in this session's
handoff", and that grant has since landed as PLAN decision D26**, which names exactly those files,
cites this spec by path, and carries the W1.1 sequencing condition as load-bearing. Do not add it
again; read `PLAN.md` D26. **A spec may not assert its
own exemption.** If P5.4 ever needs a route it still stops and hands back to the orchestrator, per
dispatch clause 5.

**Phase 1's dependencies outside this spec are two features, not one. CORRECTED 2026-08-06.** This
paragraph named only F3 and the omission was self-concealing:

- **F3 phase 2 (P2.1 to P2.3)**, because `POST /api/v1/workspace/notes` must actually create a
  note. Before that it answers the inert scaffold's 409 (`notes-routes.ts:47-49`) and the honest
  phase-1 behaviour is T0 only. **CORRECTED 2026-08-06 (residual pass 4): "T0 only" is not a
  reduced service, it is no service**, because no tool emits a T0 read (see "Phase 1 ships one
  tool"). F3 phase 2 is not a degradation to plan around, it is the whole of phase 1's user-visible
  behaviour. What the channel does in the meantime is now specified rather than left to a reader:
  the replay reaches the route, the route answers 409, and cezar acks `replay_error` with
  `replayStatus: 409`, so the owner gets a loud outcome instead of a bubble claiming a note was
  captured.
- **F4, the notification transports** (`2026-08-06-pluggable-notification-transports.md`, packages
  **W1.7** the registry and decider, **W1.8** config and secrets, **W2.4** the webhook transport,
  **W2.5** the outbox and sender; **W4.7** adds the routes and `cez notify test <id>`, which is how
  the precondition gets checked), **plus `CEZ_NOTIFY=1`**, **plus a `loki` transport row** pointed
  at `POST /notify/v1/events` with a `notify`-scoped `lok_*` key, per PLAN decision **D23**.
  **Every outcome bubble in this design leaves cezar through that path and it appeared in no
  dependency list**: not in P5.4's deps, not in this paragraph, not in the end-to-end
  preconditions. Without it the ack bubble arrives (that one is minted on the chat side) and the
  **second** bubble never does, so real-device rows 1, 7, 9 and 10 fail, and so does the
  mitigation that says "an expired command produces a loud outcome through the notify path, never a
  silent drop". Note what shape that failure takes: with no notify transport configured the sender
  has nothing to send to and drops the notification, so the mitigation written to prevent a silent
  drop **fails as a silent drop**. That is why it is a precondition to verify rather than an
  assumption to carry.

**Phase 1 addresses the boot project and only the boot project.** No acceptance criterion in this
phase may be stated in terms of "which repo the command targeted", because a `/p/<id>` spelling is
refused outright and `project_scope` is `NULL` on every phase-1 row. Cross-project addressing over
text is not deferred pending a config change: it is **not designed**, and designing it means
designing a way to name a project that does not run `resolveProjectScope` on an attacker-chosen
id. That is a spec, not a flag.

### Phase 2: T2. Deferred, and blocked on three things outside this spec.

Comments and tickets need **F5**, which is phase 3 and fork-private. **CORRECTED 2026-08-06:** this
paragraph previously said "the dependency is circular only in appearance: this spec unblocks F5's
auth question by answering it". It does not. F5's phase-3 precondition is the **shared-instance
auth model** (PLAN:87-89, expanded at PLAN:281-285), which asks who a second human at a shared
cockpit port is. This spec authorizes on the Cloudflare plane and keeps cezar identity-free by D2,
so it cannot answer that question and does not claim to. That precondition is an owner decision
(PLAN:285). T2 stays blocked on F5; F5 stays blocked on the owner. The dependency argument that
rested on the circularity claim rests on nothing and has been withdrawn rather than repaired.

Phase 2 is therefore blocked on: (1) F5, itself blocked on the owner's shared-instance auth
decision; (2) **SPEC-417 P4.8**, Telegram enrolled with `enabled = 1`, because the two-transport
health gate above cannot be satisfied by iMessage alone; (3) the confirmation protocol above,
which is the only part of phase 2 designed here. No work package is opened for it.

### Phase 3: T3. Not scheduled.

Requires: every phase-0 item landed, a pre-registration UI in the cockpit, the veto path on all
enabled transports, and **a month of clean data**: zero pages from `cezar_unsigned_rejects`, and
zero `refused_sender` rows in `cezar_commands`. (This previously read "zero
`signature_verified = 0` rows in `cezar_commands`", which post-P5.0a is a tautology: the column
now carries `CHECK (signature_verified = 1)`, so that query returns zero on a compromised month
too. It was a control with no trigger.) If the residual risk of a forged dispatch during a muted
window is unacceptable when that month is up, the correct answer is that T3 does not exist over
text at all and every dispatch stays a cockpit press. Ship it that way first.

### T4: never.

---

## Data Models

### cezar side

**No schema change to any existing cezar type.** The note a text produces is an ordinary
`NoteRecord` with `source: 'api'`, which is already a member of the closed enum
(`packages/contract/src/notes.ts:22`). This is the whole reason the notes pipeline was the right
thing to extend.

**`sourceRef` carries an opaque command id, never a handle and never a chat id.**

```jsonc
{ "body": "fix the tunnel retry backoff in imsg-agent",
  "source": "api",
  "sourceRef": "cmd_QK7T2ZMB4XW3RJVN6DF5CAHS2P" }
```

The code-fit reading of this proposed `sourceRef: "imessage:<chatId>"`. Reject that.
**CORRECTED 2026-08-06: one of the two reasons given was wrong, and it was the one carrying the
authority.** The paragraph read "Reject that, for two reasons: PLAN D9 keeps PII out of cezar, and
a note's `body` and `sourceRef` both ride into the note pass prompt, so a chat id would end up in
an agent's context and in `notes-log.ndjson`." **D9 does not bite here.** D9 bars PII from a cezar
directory **that is committed** (`PLAN.md:41`, "Never in a cezar directory that is committed"), and
`~/.cezar/notes.json` and `~/.cezar/notes-log.ndjson` both sit under `cezarHomeDir()`
(`packages/cezar/src/paths.ts:134-142`), outside every checkout. The leg that holds is the prompt
one: `body` and `sourceRef` ride into the note pass prompt, so a chat id becomes model input, and
that pass can copy it into `knowledge/`, which **is** committed by design (PLAN dispatch clause 8).
D9 bites one hop later, which is exactly why the chat id must never enter the note in the first
place. The mapping from `cmd_*` to a sender lives on the platform plane, in `cezar_commands`, where
identity belongs. The audit join still works because `cmd_*` is the join key on both planes.

**`~/.cezar/command-source.json`** (new, its own file, on the `agent-accounts.json` precedent at
`paths.ts:108-124`: a cezar version that has never heard of a feature cannot drop a file it does
not open):

```jsonc
{
  "version": 1,
  "endpoint": "https://auth.example.com",          // no default compiled in (D2)
  "intervalMs": 5000,
  // DEFAULT-DENY. Empty array = nothing. Canonical keys in the one notation:
  // "<METHOD> <path>", path begins /api/v1/ and never contains /p/, `:*` for a parameter.
  // A key containing /p/ is not a key: it is refused at load, like any other key outside
  // CEZ_CMD_ALLOWLISTABLE, and the whole config is refused with it.
  // NO QUERY STRING, ever: a key is a method plus a PATHNAME. `?` or `#` in an entry is a
  // malformed key, refused at load the same way. It does not narrow anything, because the
  // matcher never sees a query: canonicalise() keys url.pathname and lets url.search ride
  // to the loopback fetch unmatched, so "GET /api/v1/knowledge/search" is the key that
  // admits `?q=...`. Arguments are bounded by each route's own zod validator, not here.
  // Shown here at phase 1's full extent: all six allowlistable keys. This example previously
  // listed three, which read as a shorter allowlistable set than the six named in Solution.
  "allow": [
    "GET /api/v1/workspace/runs",
    "GET /api/v1/workspace/notes",
    "GET /api/v1/workspace/notes/:*",
    "GET /api/v1/knowledge",
    "GET /api/v1/knowledge/search",
    "POST /api/v1/workspace/notes"
  ]
}
```

**A key outside `CEZ_CMD_ALLOWLISTABLE` fails the whole load, loudly, and the effective allowlist
stays `[]`.** Not "that entry is skipped": a partially applied security config is worse than a
refused one, because the operator believes something is configured that is not. The entry shape is
one string rather than the earlier `{method, path}` object precisely so that the config file, the
tier table, the platform catalogue and the compiled-in set are all comparable by string equality,
with no second parser to disagree with the first.

The token and the signing key are **never** in this file. They are `CEZ_CMD_TOKEN` and
`CEZ_CMD_SIGNING_KEY` in the environment, matching the `CEZ_NOTIFY_TOKEN` precedent (SPEC-417
Q15) and, critically, matching `SECRET_NAME_RE`
(`packages/cezar/src/core/secret-redaction.ts:28-29`, which matches `TOKEN` and `_KEY$`), so both
values are scrubbed from every persisted and streamed event. `CEZ_CMD_ENDPOINT` is deliberately
not scrubbed, because it is not a secret.

**`~/.cezar/command-receipts.ndjson`** (new): append-only, `{commandId, receiptId, status,
observedAt, updatedAt, key, projectScope, replayStatus}`, 90-day retention, reconciled on boot. It
holds no message text and no handle. `key` is the canonical key that was matched.
**CORRECTED 2026-08-06:** `projectScope` previously read "the erased `/p/<id>` segment (or
`null`), recorded separately so the receipt says both what ran and where, while the matcher only
ever compared what". Nothing is erased any more, so **`projectScope` is `null` on every phase-1
receipt**, and the field survives only as a slot for a later phase that deliberately admits a
second spelling. A receipt whose `projectScope` is non-null in phase 1 is a bug, not a record: it
would mean a `/p/` path reached the replay, which is the bypass, and negative control 6 asserts
against exactly that.

**SUPERSEDED 2026-08-06 by "The one notation, and the compiled-in allowlistable set" in Solution:
the hardcoded denylist described here is gone.** The paragraph that stood here read: "A hardcoded
denylist sits **above** the allowlist and is not configurable: `POST /api/v1/runs`,
`POST /api/v1/p/:id/runs`, any `/open-in-cli`, any `/open-in-app`, `/projects/checkout`,
`/fs/browse`, and every `/notifications/transports*` mutator. A config file cannot re-enable them."
Its property is kept and its mechanism is replaced by `CEZ_CMD_ALLOWLISTABLE`, a compiled-in `Set`
of canonical keys enforced at config load and again at replay. Three of that list's seven entries
could not be written in the one notation (a glob, a prefix, an English quantifier), one named a
route that does not exist (`/open-in-app`; the route is `/runs/:id/open-in`), and one
(`POST /api/v1/p/:id/runs`) is now **rejected** as a spelling rather than blocked as an entry,
because a path whose third segment is `p` is refused outright. (**CORRECTED 2026-08-06:** that
clause previously read "unreachable as a *spelling* ... because canonicalisation erases `/p/<id>`
before comparison". Erasure made the spelling *reachable* under a different key, which is the
bypass corrected in Solution.) A default-deny upper bound closed over
a growing route table is strictly stronger than a hand-maintained list of the doors you remembered.

### chat side, platform D1, migration `0063_cezar_commands.sql`

`0062` is **not** free. SPEC-417 allocates two migrations: `0061_notify_targets.sql` (P4.2, on disk
and untracked in the working tree today) and `0062_agent_transport_credentials.sql` (P4.8, not yet
written). SPEC-417 is the earlier allocating document and wins both. No other spec in
`chat/.ai/specs/` allocates above `0061`. **This spec takes `0063_cezar_commands.sql`**; the next
genuinely free number after it is `0064`. Write the file immediately on starting P5.1 and treat the
number as taken from that moment, the same discipline `tools/next-spec` demands for spec numbers.
Note that the SPEC-417 text once called its first migration `0061_cezar_notify.sql` while the file
on disk is `0061_notify_targets.sql`; **the file on disk wins**, because two already-written
sources cite it (`domains/platform/src/services/notify-targets.ts:2` and
`domains/platform/src/routes/notify.ts:100`). **CORRECTED 2026-08-06: that in-place correction is
done and must not be re-prescribed.** This paragraph previously ended "and SPEC-417 needs the
in-place correction rather than the file needing a rename", which is stale: SPEC-417 already
carries it at `:352-359` (`**CORRECTED 2026-08-06:** the migration landed as
`0061_notify_targets.sql`, not `0061_cezar_notify.sql` ...`), and that same block already cedes
`0063_cezar_commands.sql` to this spec. The only in-place edit SPEC-417 still owes this spec is the
`SUPERSEDED` lead-in on its P4.8 reply-path paragraph (`:632-638`).

```sql
-- The queue. One row per command, deleted by the retention sweep, never by ack.
CREATE TABLE cezar_command_queue (
  id            TEXT PRIMARY KEY,               -- cmd_*, DERIVED (see Graft 1), never random
  key_id        TEXT NOT NULL,                  -- api_keys.id permitted to claim it
  tier          INTEGER NOT NULL,               -- 0..4. Phase 1 writes only 0 and 1.
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,                  -- canonical at enqueue AND re-canonicalised by
                                                -- cezar before matching. Never contains /p/:
                                                -- enqueueCommand() refuses such a path outright,
                                                -- and so does cezar (refused_project_scope).
  project_scope TEXT,                           -- reserved. ALWAYS NULL in phase 1: nothing is
                                                -- erased, so there is nothing to record here.
  body_json     TEXT,                           -- the verbatim text cezar receives as `bodyRaw`
                                                -- and hashes before parsing. Never re-serialised.
  state         TEXT NOT NULL DEFAULT 'ready'
                -- Every value has a named writer, and that is enforced by review, not by the
                -- CHECK: 'ready' the insert and reclaim statement 1, 'leased' the claim,
                -- 'acked' the /ack transition (statement 3 -- ADDED 2026-08-06; before that
                -- nothing wrote it and every acked command was reclaimed and redelivered up to
                -- three times), 'expired' the sweep statement 2, 'cancelled' CEZAR STOP.
                CHECK (state IN ('ready','leased','acked','expired','cancelled')),
  lease_id      TEXT,
  leased_until  TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,       -- delivery COUNT, 1-based after the first claim.
                                                  -- The wire's `deliveryNo` is `attempts - 1`.
  visible_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,                  -- TTL. Minutes, not hours. See Risks.
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Leads on the sort key. NOT (state, visible_at): measured, that plan adds
-- USE TEMP B-TREE FOR ORDER BY and reads every visible row before LIMIT.
-- `id` is in the index, not decoration: `datetime('now')` is second-precision, so rows written
-- in the same second tie on created_at and need a deterministic tiebreak. Measured on this DDL
-- (sqlite 3.54.0): with (state, created_at) an `ORDER BY created_at, id` adds
-- USE TEMP B-TREE FOR LAST TERM OF ORDER BY; with (state, created_at, id) the plan is a bare
-- SEARCH ... (state=?).
CREATE INDEX idx_ccq_claim ON cezar_command_queue(state, created_at, id);

-- The audit log. ONE ROW PER *AUTHENTICATED* INBOUND ATTEMPT, successes and refusals alike:
-- a table that records only successes cannot show an attack in progress. Unsigned requests
-- never reach this table (P5.0a 401s before the body is parsed); they are counted below.
CREATE TABLE cezar_commands (
  id                     TEXT PRIMARY KEY,      -- ccm_<uuid7>, server-generated, ONE PER ATTEMPT
  command_id             TEXT,                  -- the derived cmd_*; NULL for a refusal that
                                                -- never enqueued. NOT unique: 5 retries, 5 rows.
  inbound_event_id       TEXT NOT NULL,         -- payload.event_id, the join to the message
  -- SPLIT 2026-08-06 from one `attempt_no INTEGER NOT NULL  -- retry_count, 0..4`, which was
  -- broken twice. It named the chatbots TURN-retry counter, which is 0 on every fresh delivery,
  -- so the real-device "re-POST the same webhook" row could never see 0 and 1; and cezar's ack
  -- leg never sees `retry_count` at all, so on that leg the NOT NULL column was unfillable.
  turn_retry_no          INTEGER NOT NULL,      -- = scheduling.ts retry_count, 0..4. The
                                                -- five-rows-per-turn axis.
  delivery_no            INTEGER,               -- ZERO-BASED redelivery index. CORRECTED
                                                -- 2026-08-06: this read "= attempts at claim
                                                -- time", which is one too many, since the claim
                                                -- writes attempts+1 and attempts defaults to 0.
                                                -- enqueueCommand() writes 0; the claim reports
                                                -- attempts-1. NULL ONLY on a row that never
                                                -- enqueued (those also carry command_id IS NULL,
                                                -- so they can never collide with an /ack).
  tool_call_ordinal      INTEGER,               -- forensics only; NOT an input to command_id
  key_id                 TEXT,
  agent_id               TEXT NOT NULL,
  transport              TEXT NOT NULL,         -- imessage | telegram | whatsapp
  service                TEXT,                  -- the SMS/iMessage distinction, once it is read
  sender_handle_asserted TEXT NOT NULL,
  signature_verified     INTEGER NOT NULL CHECK (signature_verified = 1),
  chat_id                TEXT NOT NULL,
  tier                   INTEGER NOT NULL,
  operation              TEXT NOT NULL,         -- canonical key: 'POST /api/v1/workspace/notes'
  project_scope          TEXT,                  -- reserved, ALWAYS NULL in phase 1 (see above)
  params_json            TEXT,
  raw_text               TEXT,                  -- bounded at 2 KB
  confirm_code           TEXT,
  confirmed_at           TEXT,
  outcome                TEXT NOT NULL
                         CHECK (outcome IN (
                           -- platform, pre-enqueue, all post-signature
                           'refused_sender','refused_tier','refused_ratelimit',
                           'refused_killswitch','refused_channel_unhealthy',
                           -- phase 2 only, owned by the confirmation protocol. It has NO
                           -- phase-1 producer, so it ships with that protocol and control 20's
                           -- sibling, never earlier: a value in the CHECK with no dated owner
                           -- and no control is a query that returns zero on a bad month too.
                           'confirm_expired',
                           -- lifecycle
                           'enqueued','cancelled','expired',
                           -- cezar, post-claim: the ack vocabulary, exactly. EIGHT values.
                           -- 'duplicate_receipt' ADDED 2026-08-06 with the /ack -> 'acked'
                           -- transition: a redelivery whose receipt is already reserved is
                           -- neither a refusal nor an error, and acking it 'executed' would be
                           -- a claim about a replay that did not happen on this delivery.
                           'refused_config_load','refused_project_scope',
                           'refused_not_allowlistable',
                           'refused_local_allowlist','refused_signature',
                           'replay_error','duplicate_receipt','executed')),
  cezar_receipt_id       TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cc_agent_time ON cezar_commands(agent_id, created_at);
CREATE INDEX idx_cc_command    ON cezar_commands(command_id);
CREATE INDEX idx_cc_event      ON cezar_commands(inbound_event_id, turn_retry_no);

-- Pre-authentication. Server clock only, nothing attacker-controlled, no PII.
CREATE TABLE cezar_unsigned_rejects (
  route         TEXT NOT NULL,
  bucket_minute TEXT NOT NULL,                  -- datetime('now') truncated to the minute
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (route, bucket_minute)
);

-- The kill switch, mirrored onto the platform plane. The in-thread STOP writes the authoritative
-- flag to conversation_config and to the chatbots AgentIndex Durable Object, and platform cannot
-- read it: AgentIndex is a chatbots DO (`agent-index.ts:51`) and platform's ONLY DO binding is
-- MCP_AGENT (`domains/platform/wrangler.toml:9-11`, `:73-75`). Without this mirror the claim
-- route cannot answer 403 for a killed agent at all, and the spec's own "403 is terminal" rule
-- would describe a response nothing could produce.
CREATE TABLE cezar_kill_switch (
  agent_id   TEXT PRIMARY KEY,
  disabled   INTEGER NOT NULL DEFAULT 0,
  reason     TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**The outcome enum is one shared constant, and the ack is a strict subset of it.** The two lists
disagreed in the earlier draft and the disagreement was fatal rather than cosmetic: the ack
contract named `refused_local_allowlist`, `refused_signature` and `replay_error`, the CHECK named
none of them, so an ack of `refused_local_allowlist` would violate the constraint and the write
would throw. This spec's own end-to-end row 10 and negative control 3 both require exactly that
value, so the mandatory verification matrix could not have passed against the schema it shipped
with. The CHECK is authoritative and is the union; the ack vocabulary is the **eight**
`cezar, post-claim` values (six until `refused_project_scope` was added 2026-08-06, seven until
`duplicate_receipt` was added later the same day with the `acked` transition); both are
generated from one exported const so they cannot drift again.

**`cancelled` has exactly one writer, the kill switch, and it is specified rather than deleted.**
A state nothing writes is a comment, but deleting it here would leave a real hole: as written,
`CEZAR STOP` refuses new enqueues (`refused_killswitch`) while a row already sitting `ready` is
still claimed and replayed, so STOP does not stop what is already queued. So: `CEZAR STOP` runs
`UPDATE cezar_command_queue SET state = 'cancelled' WHERE state = 'ready' AND key_id = ?` in the
same transaction that writes the `cezar_kill_switch` row and the `AgentIndex` flag. Nothing else
writes `cancelled`, and cezar never sees a `cancelled` row because only `ready` rows are claimable.
Each cancelled row gets one `cezar_commands` row with `outcome = 'cancelled'`, which is why
`cancelled` is in the lifecycle group of the CHECK above.

**Which row `/ack` mutates, because "the row for this command" was ambiguous across five retries.**
`/ack` updates the row matching `command_id = ? AND delivery_no = ?` **`ORDER BY turn_retry_no
LIMIT 1`**, inserting one if absent. A
**redelivery** is therefore a new row (a new `delivery_no`) and a **turn retry** is not (same
`delivery_no`, different `turn_retry_no`). Without this rule the real-device row demanding exactly
one `executed` row is unsatisfiable against the five rows a retried turn produces.

**CORRECTED 2026-08-06: as written, this clause could never match on the first ack.** The
`enqueued` row carried `delivery_no = NULL` while the claim reported `1`, so the target clause
matched nothing, `/ack` inserted a second row, and control 26(a)'s "the same row reads `executed`"
was unsatisfiable. Two edits fix it and both are above: `enqueueCommand()` writes `0`, and the
claim reports `attempts - 1`. The `ORDER BY turn_retry_no LIMIT 1` is the second half, because
five turn retries write five `enqueued` rows sharing one `(command_id, delivery_no = 0)`, so
without it the clause would be ambiguous across five rows rather than zero. The lowest
`turn_retry_no` is the drain whose `ON CONFLICT DO NOTHING` insert actually created the queue row,
so that is the row that describes the delivery that happened; the other four stay `enqueued`,
which is what they are.

Two members changed and one was deleted, each for a reason:

- **`refused_unsigned` is deleted.** There is no row to put it on. An unsigned request is refused
  before the body is parsed and is counted in `cezar_unsigned_rejects` instead.
- **`cezar_error` is deleted.** It collapsed three different incidents into one value: "the one
  control that survives a platform compromise fired", "a forged or mis-keyed envelope reached the
  Mac" (which is the cezar-plane twin of an unsigned webhook, an incident in its own right), and
  "cezar's own route returned a 5xx". A single value for all three defeats the stated purpose of
  the table. They are now `refused_local_allowlist` / `refused_not_allowlistable`,
  `refused_signature`, and `replay_error`.
- **`refused_not_allowlistable` is new and load-bearing.** Without it, a replay-time refusal is
  indistinguishable from an ordinary allowlist miss, yet it means the **platform catalogue
  enqueued a key that no configuration may ever name**, which is the highest-severity row this
  table can hold. `refused_config_load` is its sibling on the config path: the owner's config was
  refused as a whole, so the allowlist is empty for a reason other than the owner's intent, and he
  needs to be told which.
- **`refused_project_scope` is new and is the highest-severity row of all.** It means a claimed
  command carried a path whose third segment is `p`. Since `enqueueCommand()` refuses such a path
  before it writes a queue row, the only ways to see this value are a platform compromise, a
  catalogue defect, or a command minted around the enqueue path. It must never be folded into
  `refused_not_allowlistable`: one says "a key outside the compiled-in bound", the other says
  "an attempt to address a project context on the way to `spawn('bash')`". They are different
  incidents with different responses.
- **`duplicate_receipt` is new and it is the only evidence the redelivery path ever ran.** A row
  carrying it means a lease expired, the reclaim statement re-readied the command, and cezar met a
  receipt it had already reserved. Before the `acked` transition existed that row would have been
  ordinary rather than notable, because **every** acked command was being reclaimed on a 30-second
  timer. Now it is rare by construction, and a run of them means leases are expiring for a real
  reason (a partition, a wedged replay) rather than because nothing closed the row.

Retention: 90 days on `cezar_commands`, longer than notify's 30, because this question is asked
after the fact. Swept on write, the same shape SPEC-417 uses for `notify_events`.

`api_keys` needs **no schema change**: `scope = 'cezar-cmd'` added to `KEY_SCOPES`
(`chat/packages/types/src/key-scopes.ts:28`, a closed array; **CORRECTED 2026-08-06**, this was
cited as `:20-26` in two places, which is a comment block about the removal of the `line` scope,
and the array itself is one line further down at `:28`) plus a `metadata` JSON carrying
`{"agentId": "agt_cezar"}`. Adding a scope to a closed whitelist is a line; adding one to a
fail-open classifier would be a hole, which is why the scope must be added to the mint whitelist
**and** to the imsg-api read classifier in the same commit. P4.3 already closed both directions
(see P5.0c), so this is a line, not a hole.

**Liveness, and the write that costs more than the polls.** `last_poll_at` lives on the key's
row and is written only when the stored value is older than 60 seconds, and never on an empty
poll. It is a **stored timestamp plus a stored state, never an age computed at request time**
(PLAN D8), because cezar's cockpit will proxy it and `route-parity.test.ts` compares three
identical GETs byte-for-byte.

---

## API Contracts

### `POST https://auth.lokimessages.com/internal/cezar/commands` (chatbots to platform)

**ADDED 2026-08-06 (residual pass 4). Every platform-D1 write in this design is made from the
chatbots worker, and the hop that carries it was never named.** `enqueueCommand()`, the
`cezar_commands` audit rows, the `cezar_unsigned_rejects` counter, the `(agent_id, tier)` budget
mirror and the `cezar_kill_switch` mirror all live in platform D1 (migration `0063`, P5.1), and
every one of them is written from inside the `cezar-control` capability module or from
`imsg-webhook.ts`, both of which run in the **chatbots** worker. That worker has **no D1 binding at
all**: `domains/chatbots/worker/wrangler.jsonc` declares `kv_namespaces` and `durable_objects` and
no `d1_databases`. It cannot write those tables directly and never could. Every chatbots-to-platform
write in this estate today is an HTTP call to `PLATFORM_HOST` carrying `X-Internal-Secret`
(`entitlements.ts:332-338`, `tools/plan.ts:169-173`, `imsg.ts:124-130`), and this spec already
builds the **reverse** leg to exactly that shape for the kill switch
(`POST /internal/agents/:agentId/cezar-kill-switch`, platform to chatbots, `internal-admin.ts:38-44`).
The forward leg is the same problem and takes the same answer. Note how the gap hid: P5.1 says
"platform: ... `enqueueCommand()`" and P5.3 says "chatbots: ... `ON CONFLICT DO NOTHING` enqueue",
so each package reads complete and the seam between them is in neither.

One route on platform's existing `/internal` router, behind its `X-Internal-Secret` gate, never a
`Bearer` (the `cezar-cmd` bearer belongs to `/cezar/v1/*` and is cezar's, not the worker's):

```jsonc
// POST /internal/cezar/commands
{ "audit":   { /* one cezar_commands row, every NOT NULL column supplied by the caller */ },
  "enqueue": { /* the cezar_command_queue row; ABSENT when audit.outcome is a refusal */ } }
// 200 { "commandId": "cmd_...", "enqueued": true | false }
```

- **`enqueue` present** runs `enqueueCommand()`: its `/p/` refusal, its
  `ON CONFLICT(id) DO NOTHING RETURNING id`, and `delivery_no = 0` on the `enqueued` audit row.
  Zero returned rows means duplicate, which means success, and `enqueued: false` is what lets the
  tool return the byte-identical acknowledgement on all five turn retries.
- **`audit` alone** is the refusal path: `refused_sender`, `refused_tier`, `refused_ratelimit`,
  `refused_killswitch`, `refused_channel_unhealthy`, all with `command_id IS NULL`. The CHECK's
  comment calls that group "platform, pre-enqueue", which stays true of where the **row** is
  written; the **decision** is made in the capability module, which is what negative controls 2 and
  23 assert on.
- **The unsigned-reject counter is a separate, bodiless call**, `POST /internal/cezar/unsigned-reject
  { route }`, issued after the 401. It must not reuse the shape above, which requires columns an
  unsigned request cannot supply without fabricating them, and fabricating them is the defect
  `CHECK (signature_verified = 1)` exists to make impossible. Bound its cost deliberately: this is
  the one write in the design an **unauthenticated** caller chooses the rate of, and a D1 write is
  worth roughly a thousand reads (see the two cost traps).

P5.2 owns this route because it is a platform route; P5.3 owns the caller; P5.3 already depends on
P5.2, so the ordering needs nothing new.

### `POST https://auth.lokimessages.com/cezar/v1/commands/claim`

Auth: `Authorization: Bearer lok_...` with `scope = 'cezar-cmd'`. `X-Internal-Secret` is never
accepted here. Mounted **before** the `/internal` router and before the JWT-scoped mounts, the
same ordering discipline SPEC-417 applies to `/notify/v1`, and identity is derived **only** from
the `Authorization` header because platform applies permissive reflected-origin CORS at
`app.use("*")`.

```jsonc
// request. ADDED 2026-08-06 (residual pass 4): both fields are HINTS the server clamps, never
// values it binds verbatim. `leaseSeconds` is what ends up inside `datetime('now', ?2)` on the
// claim, so an unclamped one hands the caller the visibility timeout that "The visibility timeout
// covers hand it to cezar" fixed at 30 seconds, and a caller asking for a day turns every crash
// into a day-long stall. Clamp: leaseSeconds to at most 30, maxCommands to at most 10.
{ "maxCommands": 5, "leaseSeconds": 30 }

// 200
{
  "leaseId": "lse_01J...",
  // Every timestamp on the wire is ISO-Z with milliseconds, produced by the single
  // sqlToIso() converter at the route boundary. D1 stores the SQL space format and
  // only the SQL space format; the two never meet in a comparison. `t` inside `sig`
  // is the SAME instant as `issuedAt` and is the only signed and windowed value:
  // cezar refuses unless Date.parse(issuedAt) === t * 1000, before it computes the MAC.
  "serverTime": "2026-08-06T14:03:11.000Z",
  "commands": [
    {
      "commandId": "cmd_QK7T2ZMB4XW3RJVN6DF5CAHS2P",
      // ZERO-BASED. = cezar_command_queue.attempts - 1 (attempts is 1 after the first claim).
      // cezar echoes this back on /ack; it is half of the audit row's target clause.
      "deliveryNo": 0,
      "tier": 1,
      "method": "POST",
      // Raw, verbatim, query string and all. It is what the signature covers, and it is what
      // canonicalise() is handed. The KEY the allowlist matches is url.pathname only; a query
      // rides to the loopback fetch unmatched. See canonicaliser rule (e).
      "path": "/api/v1/workspace/notes",
      // The VERBATIM body_json column text. cezar hashes this string, then JSON.parses it.
      // There is no canonical-JSON step and no re-serialisation anywhere on this hop.
      "bodyRaw": "{\"body\":\"fix the tunnel retry backoff\",\"source\":\"api\",\"sourceRef\":\"cmd_QK7T2ZMB4XW3RJVN6DF5CAHS2P\"}",
      "issuedAt": "2026-08-06T14:03:09.000Z",   // = t
      "expiresAt": "2026-08-06T14:18:09.000Z",  // = expiresAtUnix, below
      // ADDED 2026-08-06. It is in the signed string and it used to be in NO wire field, its
      // derivation implied only by a comment on this example. A MAC input derived independently
      // on both sides is the same defect the issuedAt/t binding fixed. cezar refuses unless
      // Date.parse(expiresAt) === expiresAtUnix * 1000, before it computes the MAC.
      "expiresAtUnix": 1786025889,
      "sig": "t=1786024989,v1=9f2c..."          // 1786024989 IS the issuedAt instant
    }
  ]
}

// 200 with an empty array is the NORMAL case and must not be logged as an error
{ "leaseId": null, "serverTime": "...", "commands": [] }
```

| code | meaning | what cezar does |
|---|---|---|
| 200 | zero or more commands | replay them; reset backoff |
| 401 | missing, invalid, revoked or expired key | **terminal.** Log once loudly, stop polling. |
| 403 | valid key, wrong scope, or the kill switch is engaged (read from `cezar_kill_switch`, which is why the flag is mirrored into platform D1) | **terminal.** Same. The poller does **not** recover by itself when the switch is cleared: re-enabling is `POST /admin/cezar/kill-switch/clear` on platform behind the super-admin gate (P5.3b, see "The reset, which nothing built"), followed by a poller restart, and the real-device recovery rows say so. **CORRECTED 2026-08-06:** this said "re-enabling is a cockpit action" and named no surface, and no package built one; cezar's own cockpit can reach neither plane. |
| 429 | rate limit, with `Retry-After` | back off to the header's value |
| 5xx | platform fault | jittered backoff, `min(60s, 5s * 2^n)` |

**The 401 is one opaque response, and this design deliberately does not inherit its own cited
precedent.** `POST /cezar/v1/commands/claim` and `/ack` return byte-identical
`401 {"error":"unauthorized"}` (same status, same body, same headers) for an absent, malformed,
unknown, revoked or expired key, so the surface is not a key oracle. `403` is reserved for an
**authenticated** key that lacks the `cezar-cmd` scope or that hits the kill switch, which leaks
nothing the caller does not already know.

The precedent this spec cites elsewhere, `POST /internal/validate-key`
(`platform/src/routes/internal.ts:47-52`), does the opposite on purpose: **404 unknown**, 403
revoked, 403 expired, for logging. That is correct **there** and wrong **here**, and the difference
is the caller, not the taste: validate-key is internal-secret-gated service-to-service with a
trusted caller, while this route is reachable by anyone holding a string. **P5.2 must therefore
collapse validate-key's status before responding**, and record the true cause only in
`cezar_commands.outcome` and the worker log. This is also what makes the poller's "401 is terminal"
rule correct rather than merely convenient: all four causes are terminal for a process that cannot
re-mint its own key.

### `POST https://auth.lokimessages.com/cezar/v1/commands/:commandId/ack`

```jsonc
{ "leaseId": "lse_01J...",
  // Echoed verbatim from the claim. Half of the audit row's target clause, with command_id.
  "deliveryNo": 0,
  // The ack vocabulary is exactly the `cezar, post-claim` group of the cezar_commands
  // CHECK, generated from the same exported const. EIGHT values, no ninth
  // (`refused_project_scope` was added 2026-08-06 with the /p/ rejection rule;
  //  `duplicate_receipt` later the same day with the leased -> acked transition).
  "outcome": "executed" | "refused_local_allowlist" | "refused_not_allowlistable"
           | "refused_config_load" | "refused_project_scope" | "refused_signature"
           | "replay_error" | "duplicate_receipt",
  // The status the loopback answered with, or null when there was no response at all.
  // CORRECTED 2026-08-06 (residual pass 4): this read "null on every outcome that performed
  // no replay, which is all seven non-`executed` values", which is false of `replay_error`
  // after a 500 or a 409 -- that replay happened and has a status. See the rule below.
  "replayStatus": 201,
  "receiptId": "rcp_01J..." }
```

**Which replay statuses are `executed`, and which are `replay_error`. ADDED 2026-08-06 (residual
pass 4).** The two values were named all through this spec with no line drawn between them, and
phase 1 has a live case sitting exactly on that line: with `CEZ_NOTES` unset,
`POST /api/v1/workspace/notes` answers **409** (`notes-routes.ts:47-49`), which is the state of the
machine until F3 phase 2 lands, and F3 phase 2 is a dependency rather than a guarantee. The rule:
**`executed` iff the replay returned a 2xx; every other status, plus a timeout, plus a transport
error, is `replay_error`.** `replayStatus` carries the status whenever a response arrived, 409 and
500 included, and is `null` only when none did (timeout, transport error) and on every outcome
refused before the replay. Two things follow and both are the reason to write it down: a 409 from a
flag-off route produces a loud outcome instead of a bubble claiming the note was captured, and
control 25's 500 row keeps its `replay_error` ack while gaining a non-null `replayStatus` on the
receipt and the audit row.

`200 {ok: true}`. **The handler runs two writes in one batch:** the queue transition
`leased -> acked` guarded on `lease_id` (statement 3 under "The queue lives in platform D1"), and
the audit update on `command_id = ? AND delivery_no = ?` `ORDER BY turn_retry_no LIMIT 1`.

A 409 means the lease expired and the command was already redelivered; cezar
treats that as informational and does not retry, because the receipt has already absorbed the
duplicate. Mechanically it is **zero rows returned by statement 3**: the row is no longer `leased`,
or its `lease_id` has moved. **CORRECTED 2026-08-06: this 409 was unreachable before the `acked`
transition existed**, which is the same defect the reclaim correction fixed on the other edge, and
it is why this paragraph now names the statement that produces it rather than describing a
condition nothing evaluated.

### The local replay cezar performs

```
POST http://127.0.0.1:4321/api/v1/workspace/notes
Host: 127.0.0.1:4321          <- loopback, so the Host guard passes unchanged
(no Origin header)            <- non-browser caller, asserted 201 at origin-guard.test.ts:175-179
content-type: application/json
{"body":"...","source":"api","sourceRef":"cmd_QK7T2ZMB4XW3RJVN6DF5CAHS2P"}
```

A query-carrying example, to make the split concrete:

```
GET http://127.0.0.1:4321/api/v1/knowledge/search?q=tunnel%20retry&limit=5
        key matched:  GET /api/v1/knowledge/search        <- url.pathname only
        not matched:  ?q=tunnel%20retry&limit=5           <- url.search, rides along
```

**`url.pathname + url.search` here is byte-identical to the `path` that arrived on the wire.**
**CORRECTED 2026-08-06: this read "`url.pathname` ... is byte-identical to the `path`", which was
true only for a command with no query string, and it was the sentence a reader would have built a
query-less key on.** The `URL` object
was built once, in the canonicaliser, from the raw path, and was never mutated; the key was a
separate pure string computation over `url.pathname` that fed only the matcher. There is no rewrite
step, and a `/p/` path never reaches this point at all, because it was rejected at
canonicalisation. **Byte-identity is now a checked reject condition** (canonicaliser rule (b2))
rather than an assumption about `new URL`, which re-spells backslashes as slashes and
percent-encodes several characters.

`AbortSignal.timeout(10_000)` on the replay, the `update-check.ts:9,15` idiom. A replay that
times out is acked as `replay_error` with the receipt left reserved, so boot reconciliation
resolves it rather than silently retrying.

### The outcome leg: unchanged, SPEC-417's route

```
POST https://auth.lokimessages.com/notify/v1/events
Authorization: Bearer $CEZ_NOTIFY_TOKEN        <- the NOTIFY key, a different key
{ "event": "command.executed", "title": "note captured",
  "body": "fix the tunnel retry backoff",
  "dedupeKey": "cmd:cmd_QK7T2ZMB4XW3RJVN6DF5CAHS2P" }
```

Two separate keys with two separate scopes is deliberate, not an oversight: revoking commands
must leave notifications alive, because that is how an attack gets watched.

**"Unchanged" describes SPEC-417's receiving end, not cezar's sending end, and the sending end is
a dependency this spec forgot. ADDED 2026-08-06.** cezar does not POST this by hand. It goes
through **F4**'s notifier: the registry and decider (W1.7), config and secrets (W1.8), the webhook
transport (W2.4) and the outbox and sender (W2.5), driven by the single `loki` transport row that
PLAN decision **D23** pins to this endpoint, behind `CEZ_NOTIFY === '1'` exactly. So every outcome
bubble in this design has five prerequisites that appeared in no dependency list until now:

1. F4 packages W1.7, W1.8, W2.4 and W2.5 landed (W4.7 adds `cez notify test <id>`, which is how
   the precondition is checked rather than assumed).
2. `CEZ_NOTIFY=1` on the Mac. Not `true`, not `yes`: the exact string, per F4's Q3.
3. A `loki` transport row in `~/.cezar/notifications.json` with `enabled: true`, pointed at
   `POST /notify/v1/events`.
4. `CEZ_NOTIFY_TOKEN` set to a `notify`-scoped `lok_*` key. This is a **second** key from
   `CEZ_CMD_TOKEN` and that is the whole point of the two-key split.
5. On the receiving side, SPEC-417's iMessage target enrolled and `enabled = 1`. D23 is explicit
   that naming a channel is necessary and not sufficient: enrollment is the authority.

**What breaks without them is the mitigation itself.** With no transport configured, F4's sender
has nothing to send to and the notification is dropped. So the row in the Risks table that promises
"an expired command produces a loud outcome through the notify path, never a silent drop" **fails
as a silent drop**, which is the exact failure it was written to prevent. Real-device rows 1, 7, 9
and 10 all read a second bubble and all fail the same way. The dependency now sits in P5.4's deps,
in the phase-1 prose, and in the end-to-end preconditions.

### `GET /api/v1/health` (cezar, existing route, one additive capability)

`capabilities.command` joins the five scaffold flags, gated on `CEZ_CMD === '1'` exactly, in
`resolveCapabilities` (`packages/cezar/src/server/capabilities.ts:136-158`). Additive to
`capabilitiesSchema`. With the flag unset the health body and the agent system prompt must be
**byte-identical** to the pre-change build, which is the PLAN's own honesty check.

---

## Risks

### Why the other two candidate transports lost

**The WebSocket candidate (cezar holds a persistent outbound `wss://` to a hibernatable Durable
Object).** It lost on three counts, none of them cost.

1. **Revocation is not atomic, and the reason it is not is a rounding error.** It re-validates
   the key lazily, once per dispatch, deliberately, to avoid waking the DO. **The saving being
   protected is under 1,000 GB-s a month against 400,000 included**, which is the claim that
   actually carries the argument and it holds across three orders of magnitude of dispatch volume.
   (An earlier draft put a point estimate of "roughly 12 GB-s a month" here with no derivation.
   12 GB-s at 128 MB is exactly 93.75 s of billed wall time, i.e. about 940 dispatches a month at
   ~100 ms of extra wake each. Both of those are assumptions, neither was measured, and the
   argument never needed a point estimate. Treat any figure in this bullet as an estimate with its
   arithmetic shown, never as a measurement.) On a command channel, a live socket that outlives
   the DELETE is not a trade worth making for a saving that does not exist.
   Every poll in the winning design re-presents the credential, so revocation takes effect within
   one interval, always.
2. **Liveness is one-directional and the failure is invisible.** macOS sleeps and the socket dies
   without a FIN. A hibernated DO runs no code and therefore cannot ping, so from the server side
   "connected and idle" and "gone since 02:40" are the same state; detection is lazy, at the
   first dispatch that times out. The candidate says this about itself, honestly and clearly, and
   it remains disqualifying on a **dev workstation**, where sleeping is the normal case rather
   than the exception. The winning design's worst state is "late", which is observable, and its
   liveness signal is strictly better evidence: "a live process executed a request 4 seconds ago"
   is a stronger claim than "a TCP connection is nominally open".
3. **It invents a verb vocabulary, which is both a D2 hazard and a new RCE surface.** A
   `{verb, project, args}` frame is a Loki-shaped schema living in cezar `src/`, and dispatching
   it needs new executor code on the Mac. New executor code is exactly where a remote-control bug
   lives. The replay envelope has neither problem, and the candidate itself would have had to
   adopt it to pass D2.

It was ahead on exactly one axis, and the winning design owes it an answer: no durable
server-side queue means a compromised platform cannot plant a command that detonates hours later
on wake with nobody watching. The answer is the category-dependent TTL plus a loud expiry notice,
below, and it is a real cost rather than a free win.

**The tunnel candidate (expose cezar's own HTTP through a Cloudflare Tunnel).** Refused, not
hardened. Two reasons, one of which is decisive on its own.

1. **In its literal form it does not work.** cloudflared forwards the original `Host` unless
   `httpHostHeader` is set, and the imsg ingress writer sets no `originRequest` block at all
   (`imsg-api/src/routes/internal/tunnel.ts:376-395`). So cezar sees a public hostname,
   `isLoopbackHostHeader` returns false, and every `/api/*` route 403s. This is asserted against
   exactly that shape of hostname: `packages/cezar/src/server/host-guard.test.ts:66-77` loops
   `['attacker.example', 'attacker.example:4321', 'cezar.attacker.example', '192.168.1.10:4321']`
   across `/api/v1/health`, `/api/v1/projects`, `/api/v1/fs/browse` and `/api/v1/runs` and expects
   403 on all of them.
2. **Decisive: every configuration that makes it work removes the Host guard for the whole
   process, which re-opens DNS rebinding against a still-loopback-bound cezar.** The guard is
   skipped when `isHostedMode()`, which is `CEZ_REMOTE === '1'` or a non-loopback bind
   (defined `server/server.ts:1285`, applied `:1291`; `capabilities.ts:142` is the `localHandoff`
   expression it negates, not the definition), and
   `host-guard.test.ts:88-91` asserts that exemption with a **200**. Trace it: the owner visits a
   page on `attacker.example` on that Mac (no tunnel involved, no hostname leaked); DNS rebinds
   to `127.0.0.1`; the page POSTs `/api/v1/runs` with `Host: attacker.example`; check 1 is exempt;
   check 2 compares Origin to Host and they match, so `sameOrigin` is true and `Sec-Fetch-Site`
   passes too, because the page genuinely is same-origin with itself; `POST /api/v1/runs` accepts
   an inline step chain and a `command` step is
   `spawn('bash', ['-lc', command], { cwd: state.cwd, env: process.env })`
   (`packages/cezar/src/workflows/run.ts:3380`). On that Mac `process.env` reaches the 1Password
   session, `gh` auth, `CF_API_TOKEN`, `ANTHROPIC_API_KEY`, and SSH agent access to the
   production mini. **The tunnel candidate does not merely add a door; it removes the lock from
   doors that were already closed, on the machine the owner browses with, and the attack needs no
   hostname leak and no credential leak at all.** The guard's own docblock says what it was for.

   The launch key is no fallback (`server.ts:3011-3012` hands it to anyone who passes the guard,
   it is minted at `:1204`, and no API route consults it), and the second half of the origin guard only runs when an
   `Origin` header is present, so it is a CSRF guard and the tunnel's callers are not browsers.

   The strongest argument *for* the tunnel is genuinely strong and is answered here rather than
   ignored: it needs **zero new cezar code**, which is a real property that neither other
   candidate has. **The second half of that argument has been deleted rather than repaired.** It
   read "and the imsg tunnel has a good production record (zero 502/503/504 rows in
   `message_lifecycle` across three months)", and that claim was unsupportable three ways.
   (a) The table has no HTTP status column at all: its `status` CHECK is
   `('requested','accepted','sent','delivered','read','failed','timeout')`
   (`imsg-api/migrations/0021_message_lifecycle.sql:21-22`), and `error_code` is the agent's own
   integer, observed only as `500` and `4`. (b) Retention is **31 days**
   (`imsg-api/src/cron/retention.ts:2,8`), so three months cannot exist: queried against
   `imsg-db-production` on 2026-08-06, the oldest row is `2026-07-06 12:10:08`. (c) Over the 31
   days that do exist, 2,614 rows, `error_code IN (502,503,504)` is indeed 0, but **vacuously**,
   and meanwhile **1,449 rows, 55.4%, are `timeout`**, accepted then never receipted for an hour
   (`imsg-api/src/index.ts:112-114`), spread across 25 of 25 July days and 5 of 6 August days,
   plus 61 `failed`. The tunnel's production record does not read as "good" and this table cannot
   settle it either way. Zero new code buys
   cheapness by relocating the authorization decision into the codebase least equipped to hold
   it, and a good transport record says nothing about a rebinding regression. Note also that
   cezar's own installers already enforce a higher bar than the imsg precedent being copied
   (`server-install/platforms/macosx-ngrok.ts` mandates `--basic-auth` with a 6-character
   minimum; `ubuntu-vps.ts` mandates nginx `auth_basic`), so adopting that precedent verbatim
   would ship cezar into a configuration its own maintainers refuse to let an operator create
   through the supported path.

### The rest

| risk | mitigation |
|---|---|
| **The inbound iMessage webhook does not verify its signature** (`imsg-webhook.ts:26-39`, `if (signature)` with no `else`), so `sender_handle` is spoofable by an unsigned POST to a public URL. This design does not create the hole and does not fix it; it makes it **load-bearing**, because an unsigned POST would enqueue a command. | P5.0a, blocking, before any tier ships including T0. Test both directions: an unsigned POST must 401, and a correctly signed POST must still 200. Mutation: restore the `if`. The 401 test must **fail**. |
| **A stale command is worse than a lost one.** "Restart the tunnel" queued at 09:00 and executed at 15:00 when the Mac wakes is not a late success, it is a wrong action. | Per-tier TTL, in **minutes**. T0 = 2 minutes, T1 = 15 minutes, T2 and above = 5 minutes. Anchor: the chat side already drops inbound older than 120 s (`scheduling.ts:101`, `:535`), which is this stack's shipped opinion on how long an instruction stays worth executing. T1 gets 15 minutes rather than 2 because a note capture genuinely tolerates arriving late and the Mac genuinely sleeps, and that widening is a decision rather than a default. **An expired command produces a loud outcome through the notify path, never a silent drop**, because a silent drop is indistinguishable from success on the owner's side. **CORRECTED 2026-08-06: that promise has a dependency and it was in no dependency list.** The notify path is F4 (W1.7, W1.8, W2.4, W2.5) plus `CEZ_NOTIFY=1` plus a `loki` transport row per D23, and with none of that configured F4's sender drops the notification. The mitigation against a silent drop therefore **failed as a silent drop**. It is now a P5.4 dependency and an end-to-end precondition. |
| **A silently dropped stale inbound message means the owner texted and nothing happened, with no notice.** `scheduling.ts:547` short-circuits before the dead-letter branch. Under a command channel that reads as "the command was ignored". | P5.0d. Emit one notice per dropped unit. Negative control: block a turn for 3 minutes, send a second message at t+30 s, assert on both the drop log line **and** the presence of a notice. Mutation: remove the notice. The test must **fail**. |
| **The allowlist is the whole local security model, and cezar's loopback API is unauthenticated RCE one POST away** (`workflows/run.ts:3380`). A missing, empty-means-all, prefix-matched or **alias-blind** allowlist is a text-message shell. The alias case is the one the earlier draft missed: `runsRoutes` is mounted twice, so `POST /api/v1/runs` has `2 + |projects|` live spellings, unbounded and mutable at runtime, and no enumerated list can cover them. | Default-deny; empty means nothing. **Canonicalise first**: one `URL` object, built once from the raw path, never mutated, also used for the fetch; reject `%2e`, empty/`.`/`..` segments, **and any raw path that `new URL` re-spells** (backslash-as-slash and percent-encoding, rule (b2), measured rather than assumed). Then `Set.has` on the whole key, exact, never prefix, where the key is **`url.pathname` only** and a query string rides to the fetch unmatched. Checked in **both** directions. `CEZ_CMD_ALLOWLISTABLE`, a compiled-in set of six canonical keys, bounds what any config may name, enforced at load and again at replay. First shipped capability is the inert note append. |
| **`acked` had no writer, so the reclaim redelivered every successful command.** The `state` CHECK admitted it, nothing transitioned to it, and the reclaim added in the previous round re-readied any row still `leased` at `leased_until`. A note captured at t+2s was therefore re-claimed at t+30s, twice more, and then swept to `expired` with the loud expiry notice attached. This is the same defect the reclaim fixed for `leased`, fixed in one direction only. | `/ack` runs `UPDATE ... SET state = 'acked' WHERE id = ?1 AND state = 'leased' AND lease_id = ?2 RETURNING id` in the same batch as the audit update, for **every** ack outcome and not only `executed`; zero returned rows is the documented 409. Plus `duplicate_receipt`, an eighth ack value, so a genuine redelivery can be acked truthfully instead of as `executed` or `replay_error`. Negative control 26(d). |
| **Erasing `/p/<id>` instead of rejecting it is itself the RCE.** **CORRECTED 2026-08-06:** the row above previously mitigated the alias case with "erase `/p/<id>` so the aliases collapse to one key by construction", and that erasure was the bypass, not the fix. The key answered "what" while the raw URL still carried `/p/<id>/` to `fetch`, and `v1` runs `use('*', resolveProjectScope)` ahead of every handler (`server.ts:5107`), so a signed `GET /api/v1/p/<registeredId>/knowledge` reached `contexts.context()` (`:1380`) and `ProjectContexts.build()` (`project-context.ts:301`), which calls `manager.recover()` (`:366`), which resumes a `running` run into `spawn('bash', ...)` (`run.ts:3380`). An inert flag-gated handler does not help, and neither does the absence of a handler: Hono composes matched middleware and terminates with `notFoundHandler` (`hono-base.js:290-303`). | **Reject, never rewrite.** Segment 3 **of `url.pathname`** equal to the literal `p` refuses the command with `refused_project_scope`, before segment 4 is validated, for every family, scoped-handler or not, and for `default` / boot id / any registered id alike. Reading `url.pathname` rather than the raw string is not cosmetic: `new URL` re-spells `/api/v1\p\proj9\knowledge`, which has no third raw segment, into `/api/v1/p/proj9/knowledge`, so a raw-string rule is evadable (rule (b2) rejects it a second way). `enqueueCommand()` refuses the same shape on the platform side. The property test runs over `v1RouteManifest(app)`, which unions **both** mount prefixes so the single-mount workspace families are visible to it, with a trigger guard asserting both buckets are non-empty. Negative control 6, whose erasure half **asserted this bypass** in the previous round, is rewritten as a scope-rejection half. |
| **A platform compromise defeats the platform-side allowlist and the per-command HMAC**, because both secrets live in the same Worker secret store. | The **only** control still standing is the allowlist enforced on the Mac by cezar itself. That is why it is default-empty, fail-closed, canonicalised in one place, and why `POST /api/v1/runs` is unreachable **by construction** rather than merely absent from a list: it is outside `CEZ_CMD_ALLOWLISTABLE`, so a config naming it is refused at load, and every `/p/` spelling of it is refused as a spelling. Say this plainly; do not present the HMAC as defence against a platform compromise. |
| **A durable queue lets a compromised platform plant a command that fires hours later on wake, with nobody watching.** This is the WebSocket candidate's one real advantage and the winning design must pay for it. | The per-tier TTL in minutes, plus the loud expiry notice, plus the fact that the maximum planted effect in phase 1 is attacker-authored text in a queue that needs two independent human presses to reach a runtime. Revisit before any tier above T1. |
| **The kill switch had a write side and no reset**, so its first trip, including the automatic distinct-conversation trip, would have disabled the owner's channel permanently. Three places called re-enabling "a cockpit action" and no package built one; cezar's own cockpit can reach neither `AgentIndex` nor platform D1, and by D2 must not learn how. Clearing the D1 mirror by hand is worse than nothing: the poller comes back and every enqueue still refuses. | **P5.3b**, `POST /admin/cezar/kill-switch/clear` on platform behind `localJwtAuth() + superAdmin()` (`routes/admin.ts:15`), which calls P5.3's `POST /internal/agents/:agentId/cezar-kill-switch` on chatbots **first** (the authoritative `AgentIndex` write) and clears the mirror **only** on its 2xx. That order is the fail-closed one. It does not restart the poller; 403 stays terminal. Negative control 10 mutation D. |
| **A blocking tool has no timeout** (`executeTool` never races `abortSignal`), so a long command would wedge the conversation and silently eat the owner's next message. | Fire-and-report is mandatory, not a preference. Ack means accepted, and the tool does one D1 insert plus an in-code send with no model round trip. Negative control, which is the gate rather than any latency figure: a tool that sleeps 90 s must **not** return the turn at 60 s, proving the bound does not exist; then assert the shipped tool never blocks. |
| **A failed turn re-executes its tools up to five times** (`MAX_RETRIES = 5`, `scheduling.ts:100`), so a random `commandId` files five notes for one text, and an ordinal-keyed one does the same whenever the model re-emits its tool calls in a different order. | Graft 1: derive the id from the **content**, `SHA-256(agentId | eventId | canonicalJSON({method,path,body}))`, never from a random and never from model output. `ON CONFLICT(id) DO NOTHING RETURNING id` on the queue absorbs the duplicates without throwing, because a throw would itself fail the turn and feed the retry loop. The audit table takes no such clause: five attempts, five rows. Negative control 7. |
| **cezar gains its first unconditional forever timer**, contradicting a doctrine its own codebase documents (the health publisher replaced a 5-second poll with a push socket). | Named, not hidden. `unref`'d, gated on flag plus config plus credentials, tight backoff, terminal on 401/403. It gets its own timer and explicitly **cannot** ride F4's demand-driven sender, whose W2.5 acceptance carries a negative control that fails against a fixed `setInterval`. Put the argument in the upstream PR description rather than letting a reviewer find it. |
| **A Loki shape sneaks into cezar `src/` wearing a generic costume** (D2). | The replay envelope means cezar defines no command vocabulary at all. Acceptance is F4's shape and both halves count: the poller works from JSON config alone against a fixture endpoint, **and** `grep -rn 'loki\|lokimessages\|imsg' packages/cezar/src/` returns nothing. Neither half alone. |
| **`last_poll_at` written per poll costs more than the polls themselves** (518,400 D1 writes a month at the chosen 5 s interval, $0.52 against $0.16 of polls, a 3.3x ratio). | Read-then-write, only when older than 60 s. Never write on an empty poll. Assert it: drive 100 empty polls and assert zero writes. Mutation: write unconditionally. The test must **fail**. |
| **A long poll parked in a Durable Object** would burn 2,592,000 x 0.128 = 331,776 GB-s a month, 82.9% of the account's entire included 400,000, for one connection. | Short poll. If a long poll is ever wanted it is held in the **Worker**, capped at 25 s. Written into the spec so the reflex answer ("use a DO, it is the coordination primitive") cannot be reached for later without reading this row. |
| **Debugging is two-sided by construction**: when a text does nothing, the evidence splits across a D1 queue and a Mac process log. | The receipt trail on both planes, joined on `cmd_*`. This is cost, not a freebie, and it is the same discipline the production-debugging rule already imposes for any Mac-local symptom. |
| **"Add comments" quietly becomes `POST /api/v1/runs/:*/messages`**, which is a prompt turn that spends tokens and changes a running agent's behaviour (`server.ts:3634-3693`). That is T3 wearing T2's clothes. | Named in the tier table as T3. Phase 1 and 2 ship no T3. F5 supplies the real comment object later. |
| **A `cezar_commands` row is written from an unverified body.** Every column below `signature_verified` comes from an attacker-controlled JSON payload, and an audit table that records assertions as facts is worse than no table: it manufactures evidence for the incident review. | The table is post-authentication only, structurally: `CHECK (signature_verified = 1)`, with the pre-auth path writing a clock-keyed counter and nothing else. The cost, losing per-attempt attribution for unsigned traffic, is stated in the audit-trail section rather than hidden. |
| **A migration number read off the working tree.** `0062` looked free because SPEC-417's second migration is specified but not yet written; the first, `0061`, is on disk untracked and under a different name than SPEC-417 gives it. | Read every spec's allocations, not `ls`. SPEC-417 owns `0061` and `0062`; this spec takes `0063_cezar_commands.sql`. The on-disk `0061_notify_targets.sql` wins its name over SPEC-417's prose because two shipped source files already cite it. |
| **Spec-name collision under parallel sessions.** cezar has no allocator; date plus slug is the whole identity. | Slug written immediately on creation, and treated as taken from that moment. In `chat/`, migration `0063` follows the same rule: allocate in order and write the file at once. Note the failure modes differ: a cezar clash is a same-path clash and is loud (it shows in `git status`, or the second writer sees the file), while the migration case is the silent two-names-one-number failure, which is why it needs the cross-spec read above and this row does not. |

---

## Verification

Per `AGENTS.md` "Definition of Done", gates green is **necessary and not sufficient**. This is a
user-facing feature, so its Notion row stays **QA Needed** until the real-device matrix below has
actually been executed and rows 6a and 6b have both been observed. Report that plainly rather than
rounding up.

### Gates

The two repos have different gates and neither may be invented.

```bash
# chat/  (five gates, and all five are in .githooks/pre-push: check-spec-numbers first,
#         then check-format / typecheck / lint / test in parallel)
chat/tools/check-spec-numbers
chat/tools/typecheck
chat/tools/lint
chat/tools/test
pnpm run check-format

# cezar/  exactly five commands, in order. THERE IS NO LINT AND NO FORMAT STEP.
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

Targeted while iterating (PLAN D21: `npm test -- <path>`, never `npx vitest`):

```bash
npm test -- packages/cezar/src/command/canonical.test.ts
npm test -- packages/cezar/src/command/allowlist.test.ts
npm test -- packages/cezar/src/command/poller.test.ts
pnpm --filter @loki-labs/platform exec vitest run src/routes/cezar-commands.test.ts
```

Before the device pass, verify the **deployed** sha rather than the merged one: `tools/deploy`
does not build, and the live worker name carries the `-production` suffix. A merged setting is
not a live setting.

### Negative controls. Each names its mutation, and each mutation must make a named test FAIL.

A test that passes whether or not the mechanism works proves nothing, and a control with no
trigger scores clean on a corpse.

1. **Unsigned webhook rejected, and counted rather than recorded.** An unsigned POST to
   `/webhook/imsg` returns 401, enqueues nothing, writes **zero** `cezar_commands` rows, and
   increments `cezar_unsigned_rejects` for that minute by exactly 1. **Mutation A:** restore
   `if (signature)` with no `else`. The 401 assertion must **fail**. **Mutation B:** drop the
   counter upsert. The increment assertion must **fail**. **Mutation C:** write a
   `cezar_commands` row from the unverified body. The zero-rows assertion must **fail** (and so
   must the `CHECK (signature_verified = 1)` constraint, at the database). Second direction, same
   control: a correctly signed POST must still 200, so the fix is not a blanket refusal.
2. **SMS is not iMessage, and the gate is inside the tool.** A payload with `service: "SMS"` and
   the allowlisted handle reaches the DO, runs a turn, and the model calls `capture_note`; the
   **capability module** refuses it at T1 on the third member of the sender triple, and writes one
   `cezar_commands` row with `outcome = 'refused_sender'`, `signature_verified = 1`,
   `service = 'SMS'`, `command_id IS NULL`, and `tier`, `operation` and `chat_id` all populated.
   **Zero** `cezar_command_queue` rows.
   **REWRITTEN 2026-08-06: this control could not pass, only fail.** The spec put the
   `service === "iMessage"` assert in `imsg-webhook.ts`, which returns before the DO, so no turn
   runs, no tool is called, and `tier`, `operation` and `chat_id` are never known. All three are
   `NOT NULL`, so the row this control asserts on could not be written at all: the control was
   green-on-nothing in one direction and unfalsifiable in the other. Second direction, so the fix
   is not a blanket refusal: the same payload with `service: "iMessage"` still captures a note.
   **Mutation A:** drop `service` from the sender triple. The `service: "SMS"` refusal must
   **fail** (the note is captured), and this is now a mutation an implementer can actually write,
   because the predicate exists in one place with the tier in hand.
   **Mutation B:** move the assert back into `imsg-webhook.ts` as a 401. The `refused_sender` row
   assertion must **fail**, because no row is written; that is the control on where the gate
   lives. Note what neither mutation catches and why it matters: a webhook-level refusal drops
   inbound SMS for **every product on that worker**, and negative control 17 compares assembled
   runtime config, golden prompt snapshots and `modulesFor()`, none of which observe a message
   dropped at the route. Collateral damage that no control sees is the second reason the gate is
   not there.
3. **Empty allowlist means nothing.** With `allow: []` in `command-source.json`, a valid signed
   command for `POST /api/v1/workspace/notes` is refused locally and acked
   `refused_local_allowlist`, and **no HTTP request is made to 127.0.0.1 at all** (assert the
   absence of the request, not the absence of a note: a test that only checks "no note appeared"
   also passes when the whole poller is broken). **Mutation A:** treat an empty array as
   allow-all. The test must **fail**. **Mutation B:** move the allowlist check to **after** the
   replay fetch. The "no HTTP request" assertion must **fail**. (B lives here rather than in
   control 6, because it needs a config the loader **accepted**: on a refused config the
   config-load short-circuit fires ahead of the allowlist and no fetch happens either way, so the
   same mutation is unfalsifiable over there.)
4. **Traversal, in both spellings, with one URL object that is never mutated.** Six assertions,
   one control. Assertions (a), (b) and (e) are made against `canonicalise()`'s **return value**,
   not against the eventual ack, because those paths are also refused by the allowlist and an
   ack-level assertion would pass without the path rules existing at all.
   (a) `canonicalise('POST', '/api/v1/workspace/notes/../../runs')` **rejects**. It must not
   return `{key: 'POST /api/v1/runs'}`, which is what `new URL`'s own `..` collapsing produces.
   (b) `canonicalise('POST', '/api/v1/workspace/notes/%2e%2e/%2e%2e/runs')` **rejects on the raw
   path**, before any parsing, because `new URL` collapses `..` but not `%2e%2e`.
   (c) The `URL` object handed to `fetch` is asserted to be **the same object**
   the matcher canonicalised, by identity, not by string equality.
   (d) **`fetchedUrl.pathname + fetchedUrl.search === rawPath`**, asserted on an admitted command
   **that carries a query string**: `GET /api/v1/knowledge/search?q=tunnel%20retry&limit=5` with
   `GET /api/v1/knowledge/search` allowed. Assert alongside it that the **key** was
   `GET /api/v1/knowledge/search`, with no `?` in it.
   (e) `canonicalise('GET', '/api/v1\\p\\proj9\\knowledge')` **rejects**, because `url.pathname`
   is `/api/v1/p/proj9/knowledge` and the raw path is not.
   (f) The key never contains `?` or `#`, over the whole of `CEZ_CMD_ALLOWLISTABLE` plus the
   query-carrying command in (d).
   **Mutation A:** drop the empty / `.` / `..` segment reject. Assertion (a) must **fail** (the
   function now returns an admitted key). **Mutation B:**
   remove the `%2[eEfF]` reject. Assertion (b) must **fail**. **Mutation C:** canonicalise a
   string and re-parse a fresh `URL` for the fetch. Assertion (c) must **fail**. **Mutation D:**
   rewrite `url.pathname` after matching (the shape a "just make the key and the URL agree"
   tidy-up takes). Assertion (d) must **fail** while (c) still passes, which is the whole reason
   (d) exists: identity alone does not bound the target, because the same object can be edited.
   **Mutation E:** key the whole raw `path` instead of `url.pathname`, which is the spec as it
   stood before 2026-08-06. (d)'s key assertion and (f) must **fail**, and the command in (d) is
   acked `refused_not_allowlistable` instead of replaying.
   **Mutation F:** drop rule (b2)'s `url.pathname === rawPath` reject. (e) must **fail**.

   **REWRITTEN 2026-08-06, and (d)'s old trigger is the reason.** (d) previously read
   "`fetchedUrl.pathname` is byte-identical to the raw `path` from the envelope, asserted on an
   admitted command", and every admitted command in this suite carried **no query string**, so
   `fetchedUrl.search` was always `''` and the assertion could not observe the case it now guards:
   mutation E would have passed it. Two independent facts made the old form wrong rather than
   merely weak. First, `path` was keyed whole, so a query-carrying command could never be admitted
   at all and the trigger could not have existed. Second, `url.pathname` byte-identity was asserted
   as a property of `new URL` and is not one, which is assertion (e) and mutation F.
5. **Prefix is not exact, and a parameter key swallows its literal siblings.** Three assertions.
   (a) `POST /api/v1/workspace/notes/n_123/approve` is refused with
   `POST /api/v1/workspace/notes` allowed. (b) `GET /api/v1/knowledge/proposals` is refused with
   `GET /api/v1/knowledge` allowed. (c) With `GET /api/v1/workspace/notes/:*` **allowed**,
   `GET /api/v1/workspace/notes/n_123` is admitted while
   `GET /api/v1/workspace/notes/n_123/approve` is still refused, which is the positive half
   without which a matcher that refuses every parameter key scores clean.
   **Mutation A:** change `Set.has` to `keys.some(k => path.startsWith(k))`. (a) and (b) must
   **fail**. **Mutation B:** add `GET /api/v1/knowledge/:*` to `CEZ_CMD_ALLOWLISTABLE` **and** to
   the config's `allow`. Assertion (b) must **fail**, because the parameter key admits
   `proposals`. That is the control on the "never add a `:*` key while an unshipped literal
   sibling exists at the same depth" rule, and it is why the rule is written down rather than
   assumed. **Mutation C:** let a `:*` position match more than one segment (drop the
   segment-count-exact check). Assertion (c)'s `/approve` refusal must **fail**.
6. **Scope closure: no `/p/` spelling ever reaches the replay, and the boot spelling still does.**

   > **REWRITTEN 2026-08-06. The previous version of this control asserted the very bypass it
   > existed to catch, which is worse than having no control, because it read as protection.**
   > It had a "refusal half" and an **"erasure half"**, and the erasure half read: "With
   > `GET /api/v1/knowledge` allowed (a genuinely project-scoped family, so its twin exists), send
   > the same four spellings of that read. Assert each replays **exactly once**, and that the
   > receipt records `projectScope` as the erased segment verbatim (`null`, `default`, `<bootId>`,
   > `<otherProjectId>`) rather than folding it into the key." Replaying
   > `GET /api/v1/p/<otherProjectId>/knowledge` "exactly once", on the same `URL` object control
   > 4(c) pins, is a **mandatory** trip through `resolveProjectScope` into `ProjectContexts.build()`
   > and `manager.recover()`. The control went green **because** the vulnerability was present, and
   > `M1` ("delete the erasure branch") demanded that closing the hole make the suite red. Its
   > `projectScope`-recorded-verbatim assertion is deleted outright: that assertion *is* the bug.

   Two halves, and neither alone is sufficient. The config half asserts only refusals, so it
   passes against a canonicaliser that refuses everything; row (i) of the second half is the
   positive control that catches exactly that, and rows (ii) to (v) plus the side-effect
   assertions catch one that admits everything.

   **Config half (unchanged in substance).** Table-drive over
   `aliasSpellings(bootId, otherProjectId, '/runs')`, the four concrete live spellings. For each
   spelling S, write `allow: ["POST " + S]` into `command-source.json` and assert: (a) the loader
   **refuses the config** and the effective allowlist is `[]`; (b) the signed command is acked
   `refused_config_load`; (c) **zero calls on the replay fetch stub**,
   `expect(replayCalls).toEqual([])`, which is the absence of the request rather than the absence
   of a run.

   **Scope-rejection half, driven against a REAL `createApp()`.** The fixture must be able to
   observe the side effect, not just the response, so: register a **second** project whose
   `.ai/cezar` store holds one run seeded `status: 'running'`, and subscribe to
   `contexts.onContextBuilt` (`project-context.ts:230`) before the first claim. Four rows:

   | row | command | assert |
   |---|---|---|
   | (i) | `GET /api/v1/knowledge`, allowed | replays **exactly once**, `replayStatus` 200, receipt `projectScope === null` |
   | (ii) | `GET /api/v1/p/default/knowledge` | acked `refused_project_scope`, `expect(replayCalls).toEqual([])` |
   | (iii) | `GET /api/v1/p/<bootId>/knowledge` | same |
   | (iv) | `GET /api/v1/p/<otherProjectId>/knowledge` | same |

   **The asymmetric fifth row, which is the one an enumerated fix misses.**
   `POST /api/v1/p/<otherProjectId>/workspace/notes`, with `POST /api/v1/workspace/notes`
   allowed. There is no handler at that path at all (`notesRoutes` is single-mount on
   `workspaceV1`, `server.ts:5140`), and it must still be acked `refused_project_scope` with
   `expect(replayCalls).toEqual([])`. A rule that only considers families with a scoped handler
   passes rows (ii) to (iv) and fails here.

   **Side-effect assertions, which are the ones that actually name the RCE.** After all five rows:
   `contexts.peek(otherProjectId) === undefined` (`project-context.ts:269`, the non-building
   reader), **zero** `onContextBuilt` events, and the seeded run still reads `status: 'running'`
   rather than having been rewritten to `failed` by `run.ts:1055-1060`. That last one is the
   sharpest, because it is the observable footprint of `manager.recover()` having run.

   **Plus the closure property test** over `v1RouteManifest(app)`, which unions **both** mount
   prefixes so the single-mount workspace families are visible to it: for every entry,
   `canonicalise('/api/v1' + path).key === '<M> /api/v1' + path`, and
   `canonicalise('/api/v1/p/' + id + path)` **rejects** for
   `id in {default, <bootId>, <otherProjectId>}`, with `scoped` true and false alike. **Trigger
   guard:** assert the manifest yields at least one `scoped: false` entry and at least one
   `scoped: true` entry, and fail the test if either bucket is empty.

   **Mutation M1: restore the `/p/<id>` erasure branch** (the design this spec shipped before
   2026-08-06). Rows (ii), (iii), (iv) and the asymmetric fifth row all become admitted-and-
   replayed, so their `refused_project_scope` acks and their `expect(replayCalls).toEqual([])`
   must **fail**; row (iv) additionally builds the second context, so **all three** side-effect
   assertions must **fail**; and the property test's clause (b) must **fail**.
   **Mutation M1b: erase `/p/<id>` and rewrite `url.pathname` to the unscoped path**, the tidy-up
   candidate. **Its point is that the three side-effect assertions still pass**, because nothing
   is built: a reader looking only at those would conclude the rewrite is safe. What must
   **fail** is rows (ii) to (v)'s `refused_project_scope` acks, together with control **4(d)**'s
   byte-identity assertion. Written out separately so the rewrite cannot be reintroduced as a
   cleanup on the grounds that "the RCE assertions are green".
   **Mutation M2:** allow the loader to accept any key. Config-half assertion (a) must **fail**
   for all four spellings, and (b) must **fail** for all four: the unscoped spelling now acks
   `refused_not_allowlistable` (the replay-time allowlistable check runs ahead of the local
   allowlist) and the three `/p/` spellings ack `refused_project_scope` (canonicalisation runs
   ahead of both). None of the three is `refused_config_load`, and that is the point: they are
   different facts about what went wrong and must not be conflated. (Config-half (c) still
   passes, because all three refusals precede the fetch.)
   **Mutation M3:** reject `/p/<id>` only for a hardcoded list of known project ids instead of by
   segment position. Register a **fresh** project after boot and re-run row (iv) against it: its
   refusal, its zero-replay assertion, and all three side-effect assertions must **fail**. This
   is the mutation that distinguishes "rejected by shape" from "rejected by a list somebody
   maintains".
   **Mutation M4:** move the `/p/` rejection to **after** the replay fetch. Rows (ii) to (v)'s
   `expect(replayCalls).toEqual([])` must **fail**, and row (iv)'s side-effect assertions must
   **fail**, because by then `resolveProjectScope` has already run. (The corresponding mutation
   for the ordinary allowlist lives in control 3, where the config is one the loader accepted.)
   **Mutation M5:** revert `v1RouteManifest` to `projectRouteManifest`'s scoped-prefix-only
   filter, keeping everything else. The `scoped: false` bucket empties, so the **trigger-guard**
   assertion must **fail**. Without it the property would silently narrow to the double-mounted
   families and keep reporting green over half its input, which is how the previous round's
   manifest was blind to `workspaceV1` in the first place.
7. **Content-keyed `commandId`, and an insert that does not throw.** Drive five drains of one
   inbound message (`retry_count` 0 to 4, which is `turn_retry_no`), **with the tool calls emitted
   in a different order on at least two of the drains**, and assert: exactly one
   `cezar_command_queue` row, exactly one note, exactly **five** `cezar_commands` rows with
   `turn_retry_no` 0 to 4 and identical `command_id`, and **no turn failure on drains 2 to 5**.
   This is the **only** place the five-rows behaviour is exercisable: it needs a *drain* retry,
   which is not device-inducible (a re-POST of the same webhook body dies at the DO's
   `processed_events` dedupe, `agent.ts:6358-6365`, upstream of everything here).
   **Mutation A:** swap the derivation for `crypto.randomUUID()`. The one-queue-row assertion must
   **fail** (five appear). **Mutation B:** key the derivation on `toolCallOrdinal`. The reordered
   drains must **fail** the one-queue-row assertion. **Mutation C:** drop
   `ON CONFLICT(id) DO NOTHING` for a bare `INSERT`. The no-turn-failure assertion must **fail**.
   **Mutation D:** add `UNIQUE (command_id)` to `cezar_commands` and an `ON CONFLICT DO NOTHING`
   to its insert (which is what "make the audit row idempotent too" looks like when someone tidies
   the two inserts into one helper). The five-audit-rows assertion must **fail**: one row appears,
   and the four retries become invisible to the incident review.
8. **Signature required, bounded forward, stopped by `expiresAt`, and pinned to one clock.**
   **REWRITTEN 2026-08-06** alongside the two-clock contract: the previous version asserted "a
   command whose `issuedAt` is 6 minutes in the past" is refused, which is now correct behaviour
   only if `expiresAt` has passed, and it had no case at all on the tuple-versus-window gap that
   was the real defect. Four refusals:

   (a) a command with a valid body and **no `sig`**;
   (b) `t` at **now + 120 s** (beyond the +60 s forward-skew bound);
   (c) `t` valid and inside its window, but **`now > expiresAt`**;
   (d) **`issuedAt` mutated one second off `t`, with a MAC that is valid over `t`.**
   (e) **`expiresAt` mutated one second off `expiresAtUnix`, with a MAC that is valid over
   `expiresAtUnix`.** ADDED 2026-08-06 with the `expiresAtUnix` wire field: the signed string
   carried a value the wire did not, so an implementer had to re-derive it from `expiresAt` and
   nothing bound the two renderings. That is the same defect (d) exists for, on the other clock,
   and it needs its own case for the same reason.

   Rows (d) and (e) are the only controls on the two-clock rules, and (d)'s absence is what let the
   spec publish an example (`t=1785938589` against `issuedAt: "2026-08-06T14:03:09.000Z"`, 86400 s
   apart) that its own rule refuses.
   **Mutation A:** skip verification when `sig` is absent,
   mirroring the webhook bug this spec exists downstream of. (a) must **fail**.
   **Mutation B:** drop the forward-skew bound. (b) must **fail**.
   **Mutation C:** drop the `expiresAt` check, or leave `expiresAt` out of the signed tuple so it
   can be extended by the holder of the transport. (c) must **fail**.
   **Mutation D:** stop asserting `Date.parse(issuedAt) === t * 1000`. (d) must **fail**, and it
   is the only assertion that does, which is why it is written separately from (b).
   **Mutation E:** derive `expiresAtUnix` from `expiresAt` on cezar's side instead of reading the
   wire field and asserting the equality (the shape the spec had before this field existed). (e)
   must **fail**, and only (e).
9. **Revocation takes effect within one interval.** Revoke the `cezar-cmd` key mid-run; the next
   claim returns 401 and the poller stops permanently rather than retrying. **Mutation:** treat
   401 as transient. The "stopped" assertion must **fail**.
10. **The kill switch is agent-wide, one-way from the thread, and resettable from exactly one
    authenticated surface.** `CEZAR STOP` from conversation A disables
    commands for conversation B, is intercepted before inference (assert the model was never
    invoked), and a subsequent `CEZAR START` from any conversation does **not** re-enable.
    **Then the reset half, ADDED 2026-08-06:** `POST /admin/cezar/kill-switch/clear` with a
    super-admin JWT clears the `AgentIndex` flag, the `conversation_config` flags **and** the
    `cezar_kill_switch` mirror; a following claim succeeds and a following note lands. The same
    call **without** the super-admin claim is 403 and changes nothing on either plane.
    **Mutation A:** store the flag in `conversation_config` only. The cross-conversation assertion
    must **fail**. **Mutation B:** move the interception to after inference. The
    model-never-invoked assertion must **fail**. **Mutation C:** make `CEZAR START` clear the
    flag. The one-way assertion must **fail**.
    **Mutation D:** have the reset clear the `cezar_kill_switch` mirror **only**, which is exactly
    what a hand-run `wrangler d1 execute` does and is what an implementer reaches for when the DO
    write looks like extra work. The claim starts succeeding, so a test that only reads the claim
    goes green; what must **fail** is the "a following note lands" assertion, because the
    authoritative `AgentIndex` flag is still set and the enqueue still answers
    `refused_killswitch`. **This mutation is written out because it is the failure the reset was
    specified to prevent**, and because the resulting state (a healthy-looking poller in front of a
    dead channel) is the one that reads as a bug in the poller.
    **Mutation E:** reverse the reset's order, clearing the mirror before calling the chatbots
    internal route, and make that call fail. The same "a following note lands" assertion must
    **fail**, which is the control on the fail-closed ordering rather than on the reset existing.
11. **Distinct-conversation trip, and nothing else auto-trips.** Three distinct `chat_id`s
    attempting T1 within an hour trip the kill switch rather than returning 429. **And** an
    unsigned POST at any rate does **not** trip it: the flag in `AgentIndex` **and** its
    `cezar_kill_switch` mirror are both unchanged afterwards, and a following legitimate note
    still lands. **Mutation A:** change the trip to a
    429. The trip assertion must **fail**. **Mutation B:** make an increment of
    `cezar_unsigned_rejects` trip the kill switch. The flag-unchanged assertion must
    **fail**, which is the control on "an unauthenticated request must never be able to disable
    the owner's channel". **B is written this way deliberately:** the deleted rule was
    "`signature_verified = 0` trips the kill switch", and post-P5.0a that column can only ever
    hold `1`, so a mutation phrased as "restore that rule" names something no implementer can
    write and no test can fail. The counter increment is the same rule in the only form that
    still exists. **Mutation C:** write the trip only to `AgentIndex` and not to the mirror. The
    claim route can no longer see it, so a following claim succeeds; the trip assertion, read on
    the platform plane, must **fail**.
12. **Refusals are recorded, and only authenticated ones.** Every one of controls 2, 3, 6, 8, 10,
    11, 22, 23, 24, 25 and 26 writes a `cezar_commands` row with the right `outcome` and
    `signature_verified = 1`; control 1 writes **none**.
    **Where this one runs, ADDED 2026-08-06 (residual pass 4):** six of those eleven (3, 6, 8, 22,
    25, and the cezar half of 26) are cezar-side poller tests driven against a **fixture** endpoint,
    per control 15, and a fixture writes no D1 row, so as written this control had no harness in
    either repo. It belongs on the platform side: capture those controls' `/ack` payloads as
    fixtures and replay them against the real `/ack` handler and the real
    `POST /internal/cezar/commands`, asserting the row each produces. The two repos have separate
    runners (see Gates), so a control that spans them has to name which one owns it or it is written
    in neither. **Mutation A:** write the audit row only
    on success. Each of the eleven must **fail**. **Mutation B:** drop the
    `CHECK (signature_verified = 1)` and write a row on the unsigned path. Control 1's zero-rows
    assertion must **fail**. **Mutation C:** collapse `refused_project_scope` into
    `refused_not_allowlistable`. Control 6's scope-rejection rows must **fail** on the outcome
    value, which is what keeps the highest-severity row in the table distinguishable.
13. **No `last_poll_at` write on an empty poll.** 100 empty polls produce zero D1 writes.
    **Mutation:** stamp unconditionally. The test must **fail**.
14. **Flag-off byte identity.** With `CEZ_CMD` unset, `GET /api/v1/health` and the agent system
    prompt are **byte-identical** to the pre-change build, no timer is created (assert on the
    absence of the handle, not on behaviour), and no config file is read (assert on the absence of
    the `readFile` call). **Mutation A:** default the flag to on. The identity assertion must
    **fail**. **Mutation B:** create the timer before the config and credential checks. The
    handle-absence assertion must **fail**.
15. **D2 grep, both halves.** `grep -rn 'loki\|lokimessages\|imsg' packages/cezar/src/` returns
    nothing, **and** the poller passes its full test suite against a fixture endpoint driven
    purely from JSON config. Neither half counts alone. **Mutation A:** compile in a default
    `endpoint` pointing at `auth.lokimessages.com`. The grep must **fail**. **Mutation B:** make
    the poller require a Loki-shaped field in the claim response. The fixture-endpoint suite must
    **fail**.
16. **The stale-drop notice exists.** Block a turn for 3 minutes, send a second message at t+30 s,
    assert on both the drop log line **and** the presence of a notice. **Mutation:** remove the
    notice emission. The notice assertion must **fail**. (Same control as the P5.0d risk row.)
17. **No collateral drift.** With `agt_cezar` absent from the fixtures, every existing agent's
    assembled runtime config and the golden prompt snapshots are byte-identical, and the
    `cezar-control` capability appears in no other agent's `modulesFor()`. **Mutation:** grant
    the capability to Beside in the fixture. The isolation assertion must **fail**.
18. **One timestamp format in D1.** Seed a queue row with
    `expires_at = datetime('now','+15 minutes')` and `visible_at = datetime('now','-1 second')`,
    then claim, and assert exactly one command is returned. **Mutation A:** bind
    `new Date().toISOString()` as a parameter and compare `expires_at > ?`. The
    one-command assertion must **fail** (zero are returned, permanently and silently, which is
    exactly the failure this control exists for). **Mutation B, REPLACED 2026-08-06 because the
    original was unfalsifiable.** It read: "have `sqlToIso()` emit second-precision
    (`...T14:03:11Z`) instead of milliseconds. The `ORDER BY created_at` assertion over two rows
    one millisecond apart must **fail**." D1's `datetime('now')` has no milliseconds (verified:
    `SELECT datetime('now')` returns `YYYY-MM-DD HH:MM:SS`, sqlite 3.54.0), so "two rows one
    millisecond apart" cannot be constructed, and after conversion both rows are byte-identical
    either way. The mutation could never make anything fail. **Replacement mutation B:** drop the
    deterministic `id` tiebreak from `ORDER BY created_at, id`. Seed two rows written in the
    **same second** and assert the claim returns them in `id` order across repeated runs; the
    mutation must make that **fail**. **Mutation C:** hand cezar a raw
    SQL-format `issuedAt` (`2026-08-06 14:03:11`). Every command must be refused, and the "one
    command executed" assertion must **fail**. **This control is machine-independent and must be
    kept so.** `Date.parse('2026-08-06 14:03:11')` is parsed as **local** time in Node, so an
    equality check against `t * 1000` alone would refuse on the dev Mac and admit on a UTC CI
    box, which is a control whose verdict depends on `TZ`. So cezar validates `issuedAt` against
    `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` **before** parsing it, and the suite runs
    under both `TZ=UTC` and a non-UTC `TZ` with identical results. **Mutation D:** drop the shape
    check and keep only the equality. The `TZ=UTC` run must **fail** to refuse, which is the
    assertion that the control does not depend on where it runs.
19. **The 401 is not a key oracle.** Five claims (absent, malformed, unknown, revoked and expired
    key) produce **byte-identical** responses: same status, same body, same headers,
    asserted by comparing serialised responses rather than by checking each is 401.
    **Mutation:** propagate `validate-key`'s status verbatim (404 unknown, 403 revoked). The
    identity assertion must **fail**. Second direction: a valid key without the `cezar-cmd` scope
    gets 403, so the collapse is not a blanket 401 that hides a real distinction from an
    authenticated caller.
20. **T2 fails closed on an unproven outbound channel.** With exactly one enabled transport, a T2
    request is refused with `outcome = 'refused_channel_unhealthy'`. With two enabled transports
    where the second's `last_delivered_at` is 25 hours old, it is **still** refused.
    **Mutation A:** count transport rows without requiring `enabled = 1`. The one-transport
    refusal must **fail**. **Mutation B:** drop the `last_delivered_at` freshness predicate. The
    stale-second-transport refusal must **fail**. This control is what stops the phase-2 gate from
    silently passing on a channel whose mute is undetectable.
21. **A T1 note is fenced as data and marked as untrusted.** A note whose `body` instructs the
    note pass to propose a task outside the catalog yields **no such proposal**, and the note
    renders with an untrusted-origin marker and its `cmd_*` in both the cockpit inbox and the
    review screen. **Mutation A:** remove the fence around the body in the note pass prompt. The
    no-proposal assertion must **fail**. **Mutation B:** render `source: 'api'` notes identically
    to cockpit-typed ones. The marker assertion must **fail**. This is the control behind the
    corrected acceptance criterion: the note is inert to the runtime, not to the model.
22. **`refused_not_allowlistable` has a trigger, and it beats the local allowlist.** Feed the
    poller a claimed `POST /api/v1/runs` with an otherwise **valid** config (a config the loader
    accepted): ack `refused_not_allowlistable`, `expect(replayCalls).toEqual([])`, one audit row.
    Run it twice: once with the key simply absent from the config's `allow`, and once with the
    key **injected into the in-memory allowlist at runtime**, bypassing the loader entirely. Both
    must ack `refused_not_allowlistable`; the second is what "even if the in-memory allowlist
    somehow contains it" means operationally.
    **Mutation A:** check the local allowlist before the allowlistable set. The first run's
    outcome becomes `refused_local_allowlist` and its assertion must **fail**, which is the
    control on the replay order. **Mutation B:** enforce `CEZ_CMD_ALLOWLISTABLE` at config load
    only. The **second** run is then admitted and replayed, so its refusal and its
    `expect(replayCalls).toEqual([])` must **fail**; the first run still refuses (as
    `refused_local_allowlist`), which is why the injected run has to exist at all.
23. **`refused_tier` has a phase-1 trigger, and the gate lives in the tool.** With a command
    source configured but the **T1 opt-in absent** (T0 only), the model calls `capture_note`:
    one `cezar_commands` row with `outcome = 'refused_tier'`, `command_id IS NULL`, **zero**
    `cezar_command_queue` rows, and a typed refusal in the thread. **Mutation A:** treat a missing
    opt-in as enabled. The refusal must **fail**. **Mutation B:** move the gate into the
    tool-build predicate so the tool is not registered at all. The audit row **vanishes** and the
    row assertion must **fail**, which is why the tier gate is inside the tool and not beside it:
    a refusal that leaves no record is indistinguishable from a model that chose not to call.
24. **`refused_ratelimit` is durable and keyed on something the attacker cannot vary.** Drive 21
    T1 attempts from **one** `chat_id` inside an hour: the first 20 land, the 21st is refused
    `refused_ratelimit`, and the kill-switch flag is **unchanged** (a rate limit is not a trip).
    **Mutation A:** budget on the in-memory `SlidingWindowCounter`. Recreate the DO between
    attempts; the 21st is admitted and the assertion must **fail**. **Mutation B:** make a
    per-tier limit trip the kill switch. The flag-unchanged assertion must **fail**.
25. **`replay_error` covers all three shapes, and never auto-retries.** Three rows: the loopback
    returns 500, the loopback hangs past `AbortSignal.timeout(10_000)`, and **(c) the loopback
    returns 409**, which is what a flag-off `POST /api/v1/workspace/notes` answers
    (`notes-routes.ts:47-49`) until F3 phase 2 lands. All three ack `replay_error`, all three
    leave the receipt `reserved`, and boot reconciliation resolves it with a stated reason and an
    explicit retry offer. Assert `replayStatus` too, because it is not the same on all three:
    `500`, `null` and `409`. **Mutation A:** ack `executed` whenever the ack call itself succeeds.
    All three must **fail**. **Mutation B:** resolve the receipt on timeout. The reconciliation
    assertion must **fail**. **Mutation C:** auto-retry the replay. Assert exactly one note
    exists; with the retry it double-files a note that had in fact landed, and the assertion must
    **fail**. **Mutation D, ADDED 2026-08-06 (residual pass 4):** ack `executed` for any response
    that arrived, keeping `replay_error` for the timeout only. Row (c) must **fail**, which is the
    control on the 2xx line: without it the owner gets a bubble saying the note was captured on the
    exact configuration where it was not.
26. **Every `state` and every lifecycle `outcome` has a writer, and each one is exercised.**
    (a) Pre-claim the
    audit row reads `enqueued` **with `delivery_no = 0`**; the claim reports `deliveryNo: 0`
    (`attempts` is `1`, and `1 - 1` is what goes on the wire); post-ack **that same row**, the one
    matched by `command_id = ? AND delivery_no = 0 ORDER BY turn_retry_no LIMIT 1`, reads
    `executed`, and there is still exactly one row for that `(command_id, delivery_no)`.
    (b) A row whose `expires_at` has passed is swept
    to `expired` on **both** tables and emits exactly one loud notice. (c) `CEZAR STOP` with a row
    already `ready` in the queue moves that row to `cancelled`, writes a `cancelled` audit row,
    and the poller never replays it.
    **(d) `acked` is terminal, and a successful command is delivered exactly once. ADDED
    2026-08-06.** Drive one T1 command to `executed`, then run the reclaim and expire statements
    with a clock advanced **past `leased_until` and twice more**, still inside the 15-minute T1
    TTL. Assert: the queue row reads `acked` throughout, `attempts` stays `1`, the replay fetch
    stub was called **exactly once**, there is exactly **one** `cezar_commands` row for that
    `command_id`, and **no** `expired` row and **no** expiry notice were produced.
    **(e) A genuine redelivery is acked truthfully.** Force a lease expiry between the replay and
    the ack (or drop the ack), let the reclaim re-ready the row, and let the poller claim it again.
    Assert: `deliveryNo: 1` on the second claim, **zero** additional replay fetches (the receipt is
    already reserved), an ack of `duplicate_receipt` with `replayStatus: null`, exactly one note,
    and **two** `cezar_commands` rows, `delivery_no` `0` and `1`.
    **Mutation A:** write the audit row only at ack time. (a)'s
    pre-claim assertion must **fail**. **Mutation B:** have the sweep delete the queue row without
    touching the audit row. (b) must **fail**. **Mutation C:** drop the expiry notice. (b)'s
    notice assertion must **fail**. **Mutation D:** leave already-queued rows `ready` on STOP
    (which is what the spec described before `cancelled` was given a writer). (c) must **fail**,
    and it is the control on "STOP stops what is already queued, not only what arrives next".
    **Mutation E: delete the `leased -> acked` transition**, which is the spec as it stood before
    2026-08-06. (d) must **fail** on all five of its assertions: the row stays `leased`, the
    reclaim re-readies it, `attempts` reaches `3`, the replay fires three times, three audit rows
    appear, and the sweep writes an `expired` row and fires the loud expiry notice for a command
    that succeeded. **This is the control that would have caught it**, and its absence is why the
    defect survived a round in which the reclaim itself was reviewed.
    **Mutation F:** drop the `lease_id` guard from the ack transition. Ack an already-reclaimed
    and redelivered command with the **stale** `leaseId`; the documented 409 must not appear and
    (e)'s two-row assertion must **fail**, because the stale ack closes the row the second
    delivery is holding.
    **Mutation G:** report `attempts` rather than `attempts - 1` as `deliveryNo`. (a)'s
    `delivery_no = 0` and its same-row assertion must both **fail**: the ack targets `1`, matches
    nothing, and inserts a second row that reads `executed` beside an `enqueued` row that never
    moves. **Mutation H:** write `NULL` rather than `0` as `enqueueCommand()`'s `delivery_no`.
    Same failure, from the other side of the same clause.

**Which controls exist and which are deferred, so a missing one is a decision rather than an
oversight.** `refused_channel_unhealthy` is control 20 and ships with phase 2.
**`confirm_expired` has no phase-1 producer at all**: its control ships with the T2 confirmation
protocol, and until then it is in the shared const only as a phase-2 reservation with a named
owner. Do not leave it in the CHECK with no dated owner and no control, which is how a value
becomes a query that returns zero on a compromised month too. **`duplicate_receipt` is control
26(e) and ships with phase 1**, which is the whole point of adding it beside a state transition
rather than ahead of one: an ack value whose producer is the redelivery path needs a control that
forces a redelivery, and 26(e) forces one with a clock rather than waiting for a partition.

### Real-device end-to-end. Mandatory, executable, and the gate on "Done".

Preconditions, verified before starting rather than assumed: the deployed sha matches the merged
sha; `CEZ_CMD=1` with a valid token, signing key and config on the dev Mac; `CEZ_NOTES=1` with
F3 phase 2 landed; the owner's handle in the sender allowlist; SPEC-417's iMessage transport
enrolled and `enabled = 1`; **exactly one project registered on the dev Mac beyond the boot
project**; and, for row 6b only, `WEBHOOK_SECRET` available on the dev Mac so a
correctly signed body with a wrong sender can be composed.

**CORRECTED 2026-08-06 (residual pass 4): the second project's stated reason was "so the
scope-rejection assertions have a real non-boot id to name", and this matrix has no scope-rejection
row.** The paragraph two below says so outright: the `/p/` rejection needs a command minted around
`enqueueCommand()`, which the device path cannot produce, so it lives entirely in negative control
6, whose second project is a **fixture** registered inside the test. The precondition survives for a
weaker reason worth keeping and worth stating rather than implying: row 3 reads
`project_scope IS NULL` on a machine where a non-boot project exists, so the null is a fact about
the design rather than an artefact of there being nothing else it could have held.

**Plus the outbound leg, ADDED 2026-08-06, without which four rows fail as a silent drop.** Every
row below whose pass condition includes a second bubble, an outcome or a notice reads the F4
notifier on cezar's side, and that appeared in no precondition list. That is rows 1, 7, 9 and 10
exactly: row 6a's page is minted on the **chat** side and rides SPEC-417's fan-out directly, so it
is readable without any of the five below.

- **F4 packages W1.7, W1.8, W2.4 and W2.5 landed** on the dev Mac's build.
- **`CEZ_NOTIFY=1`** in the environment. The exact string; F4 treats `true` and `yes` as unset.
- **A `loki` transport row** in `~/.cezar/notifications.json`, `enabled: true`, pointed at
  `POST /notify/v1/events`, per PLAN **D23**.
- **`CEZ_NOTIFY_TOKEN`** holding a `notify`-scoped `lok_*` key. A **different** key from
  `CEZ_CMD_TOKEN`, which is the two-key split working as designed.
- **Verified, not assumed:** run `cez notify test loki` (F4 W4.7) and see the bubble arrive on the
  phone **before** starting row 1. If W4.7 has not landed, prove the leg some other way and say
  how. Skipping this check means rows 1, 7, 9 and 10 fail identically to a channel that is
  working and quiet, which is the exact ambiguity this design exists to remove.

**One transport is enough for this
matrix because every row is T0 or T1.** T2's two-transport health gate is not exercised here and
is not exercisable until SPEC-417 P4.8 lands, which is why negative control 20 carries it instead.
The `/p/` rejection is **not** a device row: it needs a command minted around `enqueueCommand()`,
which the device path cannot produce, so it lives entirely in negative control 6. The `acked`
transition is **not** a device row either: proving a successful command is *not* redelivered needs
the clock advanced past `leased_until`, which is negative control 26(d).

**The table is written in execution order**, and every one-way row is immediately followed by its
recovery. **CORRECTED 2026-08-06: the previous order was `1, 2, 3, 4, 5, 7, 10, 8, 8b, 9, 9b, 6a,
6b`, and it was unrunnable.** Row 5 removes nothing but rows 8 and 10 do, and 8b's recovery and
6a's trailing "a following legitimate note still lands" both sit *after* the destructive block
with a revoked key between them.

| # | step | pass condition |
|---|---|---|
| **1** | **From his iPhone, text `agt_cezar`: "note: fix the tunnel retry backoff in imsg-agent".** | Within about 5 seconds one bubble arrives: the deterministic in-code ack naming the command id. Within about 10 seconds a second bubble arrives through the SPEC-417 fan-out confirming capture. |
| **2** | **Observe the effect in cezar.** On the Mac: `cat ~/.cezar/notes.json`, and open the cockpit at `/notes`. | A `NoteRecord` exists with `body` equal to the texted text, `source: "api"`, `sourceRef` equal to the `cmd_*` from bubble 1, and `status: "raw"`. It appears in the cockpit inbox. **No run was created**: `GET /api/v1/workspace/runs` is unchanged. |
| **3** | **Audit join, both planes.** `wrangler d1 execute` on platform: `SELECT id, command_id, turn_retry_no, delivery_no, transport, service, signature_verified, tier, operation, outcome FROM cezar_commands WHERE command_id = '<cmd>'`; on the Mac: `grep <cmd> ~/.cezar/command-receipts.ndjson`. | One row, `turn_retry_no = 0`, `delivery_no = 0`, `signature_verified = 1`, `service = 'iMessage'`, `tier = 1`, `outcome = 'executed'`, `project_scope IS NULL`. One receipt, status resolved, `replayStatus = 201`. The two planes join on `command_id` / `cmd_*` with no log parsing. **Then wait 90 seconds and re-run the same SELECT. It must return the identical single row**, plus `SELECT state, attempts FROM cezar_command_queue WHERE id = '<cmd>'` reading `acked, 1`. **ADDED 2026-08-06, and it is not padding:** before the `acked` transition existed this row was true when read and false about thirty seconds later, because the reclaim statement re-readied every acked command at `leased_until` and the poller delivered it twice more before the sweep wrote an `expired` row and fired a loud expiry notice for a command that had worked. A one-shot read cannot see a defect on a 30-second timer, so this row reads twice. **`delivery_no = 0` was also unreachable when this row was written:** the claim writes `attempts + 1` from a default of `0`, so the first delivery reported `1`; it is `attempts - 1` on the wire now. |
| **4** | **Re-POST the identical signed webhook body, same `event_id`.** | **Zero new rows anywhere**: still exactly one queue row, one note, and **one** `cezar_commands` row. **CORRECTED 2026-08-06:** this row previously demanded "**two** `cezar_commands` rows sharing one `command_id` with `attempt_no` 0 and 1". It cannot happen and could never have passed. The redelivery dies at the DO's `processed_events` dedupe (`agent.ts:6358-6365`), which returns *before* the `pending_messages` insert at `:6400`, so zero turns run, zero tools are called and nothing reaches the audit table at all. `attempt_no` was also the **turn**-retry counter, which is 0 on every fresh delivery, so the two rows would have been indistinguishable on `(inbound_event_id, turn_retry_no)`, the pair an incident review reads. **CORRECTED 2026-08-06 (residual pass 4): this said the rows "would have collided on `idx_cc_event`", and they would not have.** `idx_cc_event` is a plain `CREATE INDEX`, not `UNIQUE`, and it must stay that way: a single turn can emit several tool calls, which is why `tool_call_ordinal` exists, so two audit rows legitimately share that pair. Nothing throws; the rows are simply not tellable apart, which is the weaker and true statement. The five-rows-per-turn behaviour needs a *drain* retry, which is not device-inducible; negative control 7 carries it. State that limit here rather than asserting a number the device cannot produce. |
| **6a** | **Unsigned POST.** From a laptop, `curl` an **unsigned** POST to `https://bots.lokimessages.com/webhook/imsg` with the owner's handle in `sender_handle` and a note command in the body. | HTTP 401. `SELECT count(*) FROM cezar_commands WHERE created_at > '<T0>'` returns **0**, which is the correct number because no authenticated attempt occurred. `cezar_unsigned_rejects` for that minute increments by exactly 1. One page arrives on the phone. Nothing enqueued, no note, no bubble. **The kill switch is still disengaged** (the `AgentIndex` flag and the `cezar_kill_switch` mirror are both unchanged). |
| **6b** | **Forged sender, correctly signed.** On the dev Mac, which legitimately holds `WEBHOOK_SECRET`, sign a body whose `sender_handle` is **not** in the allowlist and POST it. | The transport accepts it. Exactly one `cezar_commands` row with `outcome = 'refused_sender'`, `signature_verified = 1`, `command_id IS NULL`, `tier = 1`, `operation = 'POST /api/v1/workspace/notes'`, `tool_call_ordinal` **NOT NULL**, and `inbound_event_id` matching the body. Nothing enqueued, no note. A typed refusal, not silence. **CORRECTED 2026-08-06:** this row previously asserted `tool_call_ordinal IS NULL`, which contradicts the schema it is asserting against: `tier` and `operation` are `NOT NULL`, so the row can only be written once the tier and the operation are known, which is inside the tool call, which means the ordinal exists. The sender check runs at the capability gate, matching negative control 2's "refused at T1". |
| **5** | **Refusal is visible and recorded: remove the T1 opt-in (T0 only), then text a note.** | The bot answers in one or two lines that it cannot capture notes and points at the cockpit. One `cezar_commands` row with `outcome = 'refused_tier'` and `command_id IS NULL`. **Zero queue rows.** (Phase 1 registers `capture_note` and nothing else, and a tool that is absent cannot be refused, so the T0-only configuration is the real phase-1 trigger for this outcome. "run typecheck in chat", the previous step, tests the model declining a tool it does not have.) |
| **5b** | **RECOVERY from 5.** Restore the T1 opt-in, text a note. | One fresh note lands. |
| **10** | **Local allowlist wins over the platform.** Empty `allow` in `command-source.json` (leave the platform catalogue intact), text a note. | It is enqueued and claimed, then refused **on the Mac**, acked `refused_local_allowlist`, zero replay fetches, and the phone gets a typed refusal. This proves the one control that survives a platform compromise actually runs. |
| **10b** | **RECOVERY from 10.** Restore `allow`, text a note. | One fresh note lands. The channel is proven before the one-way rows below. |
| **7** | **Mac asleep.** Close the lid, text a note, wait 2 minutes, wake. | The command is claimed on the first poll after wake and the note appears, within the 15-minute T1 TTL. Repeat past the TTL: the audit row reads `enqueued`, then flips to `expired`, and a **loud** expiry message arrives on the phone. Neither case is silent. |
| **8** | **`CEZAR STOP`, with a command already queued.** **Stop the poller first** (`cezar cmd off`, the `~/.cezar/` flag file consulted per tick, or quit the process; confirm no claim is in flight). Then text a note and confirm the queue row is `ready` on the platform plane. Then text `CEZAR STOP`, then a second note, then `CEZAR START`. Restart the poller last, to observe the 403. | The stop is acknowledged. The **already-queued** row ends `cancelled` and is never replayed. The second note is refused with `outcome = 'refused_killswitch'`. The next claim returns **403**; the poller logs one terminal line and **stops**, matching the claim contract rather than contradicting it. `CEZAR START` does **not** re-enable. **CORRECTED 2026-08-06: this said "text `CEZAR STOP` before it is claimed" and that is a race the operator loses.** The poll is 5 s jittered by plus or minus 20%, so the claim lands 4 to 6 s after the enqueue; `CEZAR STOP` is itself a text and waits `DEBOUNCE_MS = 2500` (`scheduling.ts:104`) before its turn even starts; and the only signal that the command exists is the ack bubble, which arrives **at** enqueue. That leaves roughly one to three seconds to read a bubble and type ten characters, on a step whose whole purpose is to prove `cancelled` has a writer. A verification step that depends on winning a race is not executable, so the poller is paused deliberately instead. |
| **8b** | **RECOVERY from 8.** `POST /admin/cezar/kill-switch/clear` on platform with a super-admin session (P5.3b), **then restart the poller** (403 is terminal, so it does not come back on its own). Confirm on both planes before texting: `SELECT disabled FROM cezar_kill_switch WHERE agent_id = 'agt_cezar'` reads `0`, **and** the `AgentIndex` flag is clear via `GET /internal/agents/agt_cezar/cezar-kill-switch` on the chatbots worker with `X-Internal-Secret`. **CORRECTED 2026-08-06 (residual pass 4): that route was written as an ellipsis and no package shipped a read side**, so the step this row turns on, confirming both planes before texting, was not executable and the half-reset it exists to catch would have gone unseen. The `GET` twin now sits beside the `POST` in P5.3. | A claim succeeds within one interval and one fresh note lands. **CORRECTED 2026-08-06: this said "re-enable in the cockpit" and no package built a reset**, so this row and rows 9 and 9b below it were unrunnable: cezar's own cockpit reaches neither plane, and clearing the D1 mirror by hand leaves the authoritative `AgentIndex` flag set, which makes the poller healthy and every enqueue still answer `refused_killswitch`. Reading **both** planes before texting is what turns that half-reset into a visible failure instead of a confusing one. |
| **9** | **Revoke.** `DELETE` the `cezar-cmd` key, then text a note. | Within one poll the Mac's poller logs one terminal line and stops. The command sits `ready`, then `expired`. **SPEC-417 notifications keep working**, which is the whole point of two keys, and this row can only be read at all if the F4 notify preconditions above are satisfied. |
| **9b** | **RECOVERY from 9.** Re-mint the `cezar-cmd` key, restart the poller. | A claim succeeds within one interval and one fresh note lands. |

Rows 1 through 3 are the owner's stated ask, demonstrated end to end: text from a phone, observe
the effect in cezar. Rows 5, 6a, 6b and 10 are the ones that decide whether it is safe.

**Why 6a and 6b now run early rather than last.** Neither is destructive: 6a is a rejected
`curl` and 6b is an accepted-then-refused signed body, and both leave the channel exactly as
they found it. Running them before the block that removes the opt-in, empties the allowlist,
engages the kill switch and revokes the key means 6a's "the kill switch is still disengaged"
assertion is read against a live channel, and rows 5b, 10b, 8b and 9b then re-prove that channel
after each one-way step. Under the old order that assertion sat behind three disabling rows.

**6a and 6b are two different gates and neither proves the other.** 6a is the "unsigned is
rejected and counted" gate; 6b is the "authenticated refusals are recorded" gate. The earlier
single row 6 asserted a `cezar_commands` row with `outcome = 'refused_unsigned'` and
`signature_verified = 0` for an **unsigned** request, which post-P5.0a cannot exist: the 401
returns before the body is parsed, so there is no `event_id`, no `chat_id` and no tier to write,
and the column now carries `CHECK (signature_verified = 1)`. That row would have failed forever
while looking like the most important line in the matrix. It also demanded that the unsigned
request fire the kill switch, which would have handed any stranger with `curl` a permanent
disable. Both are corrected above. **Until 6a and 6b have both been executed and observed, this is
QA Needed, not Done.**

### What to measure before widening beyond T1

Each of these falsifies a specific claim above, and none is a blocker for phase 1.

1. **Sleep and wake on the actual dev Mac.** `pmset -g log` over 30 days: wake events per day and
   the sleep-duration distribution. This is the number the transport ranking turns on, and no
   candidate measured it. If the Mac never sleeps, the WebSocket candidate's only real weakness
   evaporates and it becomes the better transport for a later tier.
2. **The real inbound floor.** p50 and p95 from the `message_lifecycle` inbound row to the first
   outbound bubble over 30 days. If p50 is already 12 seconds, the poll interval's 2.5-second
   mean is noise; if p50 is 4 seconds, it is a 60% regression and worth reconsidering.
3. **Observed duplicate execution today.** How often is `retry_count > 0` in production over 30
   days? Zero means the content-derived `commandId` work is insurance; weekly means it was a
   prerequisite.
4. **The account's real monthly Workers requests and D1 writes.** Every cost figure above is
   marginal, assuming the included allowance is already spent. At 400k requests a month the poll
   is free; at 9.8M it tips the account over and `last_poll_at` becomes a top line item.
5. **Command duration distribution.** p50/p95/p99 of runs started by the routes a later tier
   would call. Every fire-and-report argument assumes a hypothetical ten-minute coding run; if
   p95 is 3 seconds, some of the apparatus is premature.

---

## TODO for the owners of other files

**Added 2026-08-06 by the residual-fix pass.** Each item below is an edit this spec's corrections
require in a file this spec does not own. They are written here rather than made, because SPEC-417,
the notes spec, the PLAN and `packages/cezar/src/server/server.ts` all have other owners. Nothing
in this list is optional: each one is a place where a reader of that file would carry away
something this spec has since falsified, or where a package this spec now depends on has to be
told.

1. **`packages/cezar/src/server/server.ts`, the mount-order comment beginning "Workspace families
   mount LAST and that is load-bearing". Correct the reason, keep the conclusion.** (Anchor
   re-measured 2026-08-06: the comment is at `:5156-5159` in the working tree, not `:5150-5153` as
   this spec cited it, and it will move again while that file is under concurrent edit. Match the
   sentence, not the number. See "The line anchors in this file".) It currently says workspace
   families mounting last is "load-bearing"
   because it keeps `/api/v1/health` from sitting behind the project scope resolver. It does not:
   `app.route(V1_PREFIX, v1)` (`:5162`) registers `v1`'s `use('*', resolveProjectScope)` (`:5114`)
   as `ALL /api/v1/*`, which matches `/api/v1/health` no matter what is mounted afterwards, so the
   resolver runs on every health request. Health is nonetheless safe, for a different reason: on
   the unscoped mount `c.req.param('projectId')` is `undefined` and `resolveProjectScope`
   short-circuits to `bootContext` without touching `contexts` (`:1374-1378`). Replace the stated
   mechanism with that one. The conclusion (health must not resolve a project, and does not) is
   correct and should stay. This matters beyond tidiness: the same middleware-composition fact is
   what makes a `/p/<id>` path dangerous even where no handler exists, and a comment that gets it
   backwards is the one a future reader will trust.

2. **SPEC-417, the P4.8 reply-path paragraph (`:632-638`).** Unchanged from this spec's earlier
   ask and still outstanding: it needs the bolded `SUPERSEDED 2026-08-06 by
   cezar/.ai/specs/2026-08-06-inbound-agent-control-channel.md` lead-in with the original text left
   below it. See "Relationship to the two specs this touches".

3. **SPEC-417 / the F4 spec, `2026-08-06-pluggable-notification-transports.md`: this spec is now a
   named consumer of the `loki` transport row.** F4's package table lists W1.7, W1.8, W2.4, W2.5,
   W4.5, W4.7 and W4.9 as belonging to that feature and names no downstream consumer. **P5.4 now
   takes W1.7, W1.8, W2.4 and W2.5 as hard dependencies**, because every outcome bubble in this
   design leaves cezar through F4's sender. Record that in F4's sequencing so a re-scoping of those
   packages knows it has a second dependent.

4. **The PLAN's phase-4 table: add P5.0a, P5.0b, P5.0d, P5.1 to P5.5 and the new P5.3b.** P5.3b is
   `POST /admin/cezar/kill-switch/clear` on platform, added 2026-08-06 because the kill switch
   shipped with a write side and no reset. Note that P5.0b's title changed: it now **types and
   threads** `service` and refuses nothing, with the assert moved into P5.3.
   **Added by the residual pass, 2026-08-06:** P5.2 also owns `POST /internal/cezar/commands` and
   `POST /internal/cezar/unsigned-reject`, the chatbots-to-platform write hop that had no contract
   (the chatbots worker has no D1 binding, so nothing else can write the tables in `0063`); P5.3
   also owns the `GET` twin of the kill-switch internal route, without which device row 8b cannot be
   run; and the rate limits and the distinct-conversation trip are **P5.3's**, not P5.2's, with
   P5.2 owning only the mirror the claim route reads. **P5.6 is named but not opened**: it is the
   T0 read surface, which needs both a closed-enum read tool and a return leg for the replay's
   response, neither of which exists. Do not schedule it as if it were nearly free, and do not let
   the phase-1 row read as though reads ship.

5. **The notes spec, `2026-08-06-workspace-notes-cross-project.md`, two one-line edits**, unchanged
   from this spec's earlier ask and still outstanding: the phone-path sentence is incomplete rather
   than wrong (a fourth caller opens no port and needs no domain), and `sourceRef`'s docblock
   ("shortcut name, filename, or script id") needs to admit an opaque `cmd_*`. See "Relationship to
   the two specs this touches".

6. **Nothing is asked of `chat/AGENTS.md`, `CLAUDE.md` or any knowledge page by this pass.** Said
   explicitly so the absence reads as a decision.
