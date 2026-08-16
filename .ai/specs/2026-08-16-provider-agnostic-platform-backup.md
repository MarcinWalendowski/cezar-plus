# Provider-agnostic platform backup & restore

Status: **Implemented — QA Needed.** All phases (1–8) built, integrated, and wired; the full
5-command gate is green (typecheck · test 8409 passed · test:unit · build · test:package), and
N2/N3/N4/N5/N6/N7 are verified by the automated suite plus a real-binary CLI smoke against the
`local` provider (run → snapshots → verify → zero-knowledge → refuse-without-force → restore
`--force` → `--snapshot`). **QA Needed** covers what the suite can't reach: a real S3/R2 endpoint
(only the SigV4 vector + fetch-stubbed transport are covered), the scheduler firing on a live
server timer, and the cockpit in a browser. Flag: `CEZ_BACKUP=1`.
Upstreamable (generic, no fork-private strings — D2). Additive only (released npm package).

## TLDR

cezar's durable platform state — identity/orgs/users, config, the knowledge base, notes,
and per-project tasks/sources/automations config — now lives as files on one Mac, and only
a single file (`~/.cezar/config.json.bak`) has any backup. If the disk dies, the corpus is
gone. This adds a **provider-agnostic, incremental, client-side-encrypted** backup + restore
subsystem: the user configures a backend (S3-compatible — R2/S3/B2/MinIO — or a local/mounted
path), and cezar ships an encrypted, content-addressed copy of the whole durable corpus to it
on a schedule, with a real restore path. It never contends with the agents that read and write
the knowledge base: the engine only *reads* corpus files, every write in the corpus is already
atomic tmp+rename, and backup never takes a lock a writer needs.

Zero-knowledge: the provider only ever sees ciphertext (AES-256-GCM under a user-held key).
Key loss ⇒ no restore, by design.

## Problem

1. **Single point of failure.** The central-hub programme (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`)
   moves all development tracking out of Notion into cezar files on the local machine. The
   knowledge base, identity, tasks, notes and per-project config are now the source of truth,
   and they exist in exactly one place. `~/.cezar/config.json.bak` (the registry snapshot,
   written by the config store) is the *only* backup of anything, and it covers one file.

2. **No off-machine copy.** Nothing ships state off the Mac. A disk failure, a `rm`, or a
   corrupt write with no prior git commit is unrecoverable for everything that is not itself
   inside a user git repo (the mounted `.ai/specs` / `docs` corpora are in the user's repos;
   the cezar-owned state under `~/.cezar/` and `<root>/.ai/cezar/` is not).

3. **The corpus is churny and hot.** Agents read and write the knowledge base heavily during
   runs. Any backup that stalls a writer, or reads a torn file, is worse than none. The design
   constraint is not "back things up" — it is "back things up without ever being on the hot
   write path."

## Constraints (this is a released package — they win)

- **`@loki-labs/better-cezar` is released; backward compatibility wins. Additive only.** No
  reshaping of existing files, no breaking of existing routes. (This is the *opposite* of the
  `chat/` pre-launch rule.)
- **No new runtime dependency (D7).** Budget is hono, @hono/node-server, yaml, zod, smol-toml,
  ws. S3 SigV4 signing, AES-GCM, scrypt, and HMAC are all done with **`node:crypto`**; uploads
  use native **`fetch`**. Same "write the ~150-line primitive instead of adding a dep" call the
  ops spec made for ULID.
- **Opt-in, exact string `'1'` (D4):** `CEZ_BACKUP=1`. Anything else, including unset, is off.
- **Flag-off route shape (D19):** every backup GET returns `200` with an empty/false payload;
  every mutator returns `409`; **never `404`**. The feature is switched off, not missing.
- **No clock-derived field in a GET body (D8).** `route-parity.test.ts` issues the same GET three
  times and compares bodies byte-for-byte. Snapshot listings carry **stored ISO timestamps
  only** — never an age computed at request time.
- **`/api/v1/health` stays byte-identical to today** — see the design decision below.
- **Generic → upstreamable (D2).** No Loki strings in `src/`. Not fork-private.
- **Gate = 5 commands:** `typecheck`, `test`, `test:unit`, `build`, `test:package`. No lint,
  no format. Targeted: `npm test -- <path>`.

### Design decision — backup is NOT a health-payload capability

The five central-hub scaffold flags (`CEZ_KB`, `CEZ_SOURCES`, `CEZ_NOTES`,
`CEZ_WORKSPACE_VIEWS`, `CEZ_NOTIFY`) each added a required `z.boolean()` to
`capabilitiesSchema` (`packages/contract/src/health.ts`), which **grew** the `/api/v1/health`
body (`capabilities.test.ts` asserts the full object with `toEqual`; the flag-off body is
larger than the pre-scaffold build — documented in `server/capabilities.ts`). This plan
requires flag-off `/api/v1/health` to be **byte-identical to today**. Therefore `backup` is
handled exactly like **`CEZ_AUTH`**: it is read through a dedicated reader
(`backupEnabled(env)` in `server/capabilities.ts`, alongside `resolveAuthProvider`) and is
**deliberately absent from `resolveCapabilities`'s result and from `capabilitiesSchema`**.
The server gates routes and starts the timer off `backupEnabled(env)`; enabled-state is
surfaced to the cockpit only through `GET /api/v1/backup` (`{ enabled }`). This keeps the
health payload, the `capabilities.test.ts` `toEqual`, and the agent system prompt all unchanged.

### Design decision — the cockpit is a Settings section, `account`-style self-gating

Because `backup` is deliberately **not** a health capability, the cockpit cannot gate on
`capabilities.backup` the way its siblings (Knowledge/Sources/Notes) do. It follows the
**`account` section precedent** instead (`web/src/routes/settings/account-section.tsx`, whose
own docblock explains that `capabilitiesSchema` has no `auth` key so visibility "lives in the
panel" via a probe): the **global Settings → Backup section** is registered unconditionally in
`settings/registry.tsx` with **no `capability:` field**, and the section component self-gates on
`GET /api/v1/backup` (`{ enabled }`) — rendering the cockpit when on and a "Backups are off —
set `CEZ_BACKUP=1`" state when off. The settings registry auto-generates both the nav entry and
the sub-route from that one entry, so — unlike the plan's speculative file list —
**`nav-items.ts` and `routes.tsx` are NOT edited** (a top-level workspace nav item would need
`backup` in the health `Capabilities` to gate cleanly, which byte-identity forbids). This is the
one deliberate, documented divergence from the plan's chokepoint list, and it is the smaller,
more additive surface.

## Solution

A new upstreamable directory `packages/cezar/src/backup/` and one new workspace-level route
family, mounted on `workspaceV1` like `workspace-knowledge` / `workspace-todos` (backup is
machine/workspace-wide, not per-project). Five moving parts:

1. **Provider seam** — a small registry (`put`/`get`/`head`/`list`/`delete`) mirroring the
   `SourceProvider` registry and the notification-transport registry, with an S3-compatible
   provider (SigV4 hand-rolled on `node:crypto`) and a local-path provider (atomic tmp+rename).
2. **Snapshot engine** — content-addressed incremental backup (git's model, without git):
   immutable deduped `blobs/<hmacKey>`, per-run encrypted `snapshots/<ts>.manifest.enc`, and a
   `latest` pointer. Each run walks the include set, `sha256`s each file, diffs against the
   last manifest, uploads only new/changed blobs, and writes the encrypted manifest **last**
   (the manifest is the commit point). Keeps N snapshots for point-in-time restore; `gc` prunes
   unreferenced blobs.
3. **Encryption** — client-side, zero-knowledge, `node:crypto` only: scrypt KDF from a user
   key, AES-256-GCM per blob and per manifest, storage key = `HMAC-SHA256(masterKey,
   sha256(plaintext))` so the provider cannot correlate blobs to content hashes. A stored
   key-check token lets `verify` catch a wrong/lost key before a restore.
4. **Restore** — fetch a chosen manifest → decrypt → fetch+decrypt+`sha256`-verify each blob →
   write to a staging dir → atomically move into place. Fail-closed: refuses a non-empty target
   without explicit `--force`/confirmation.
5. **Surfaces** — `cez backup {status|run|restore|verify|snapshots|gc}` CLI, a Settings →
   Backup cockpit section, and the six workspace-level routes.

### The backup set (an explicit include manifest, fail-closed)

Backup covers **cezar-owned durable state only** — not the mounted read-only corpora
(`.ai/specs`, `docs`, which already live in the user's own git repos), and not
machine-pinned/runtime files. It is an **allowlist** (like `ensureDataGitignore`'s `wanted`
array), because a denylist would silently ship the next secret or lockfile someone adds.

Note the include set intentionally diverges from `.ai/cezar/.gitignore`: git ignores `sources/`
and `todos.json` as machine-local, but backup *includes* them because they are durable
cezar-owned state worth restoring. Backup ≠ gitignore; they answer different questions.

**Home (`~/.cezar/`) — INCLUDE:** `config.json`, `identity/identity.json`, `notes.json`,
`notes-log.ndjson`, `agent-accounts.json`, `ui-state.json`, `notifications.json` (durable,
non-secret transport config — the S3/webhook secrets are in env), and **`backup.json`** itself (the
backup subsystem's own config; secrets are env, only their var names appear in the file). The last
two refine this list as originally written: N5's total-classification requirement forced the call,
and leaving `backup.json` unclassified silently dropped it from every backup (and would refuse
every run once the walk fails closed — below).
**Home — EXCLUDE:** `*.bak` and `identity/*.bak-*` (e.g. `config.json.bak`,
`identity/identity.json.bak-*`), all `*.lock` (`notifications/outbox.lock`, `server.install.lock`,
the run lease `backup.lock`), `server.json` + `server-instances/*` (machine-pinned install state),
`supervisor/*` (runtime), `notifications/outbox.ndjson` (transient outbox). Filesystem junk that can
appear in any directory (`.DS_Store`, AppleDouble `._*`) is excluded in **both** scopes, so a stray
never trips the fail-closed walk.

**Per registered project (`<root>/.ai/cezar/`) — INCLUDE:** `knowledge/**` (the writable KB
content), `config.json`, `sources.json`, `sources/**` (mirrored external content),
`automations.json`, `todos.json`, `ui-state.json`.
**Per project — EXCLUDE:** `runs.json` + `runs/**` (run logs — per the scope decision),
`knowledge-index/**` (derived/rebuildable, incl. the ~17 MB embeddings blob), `launch-key`
(per-repo secret), `worktrees/**`, `tmp/**`, all `*.lock` and `*.tmp`, and the runtime state/log
streams: `*-state.json` (`automation-state.json`, `source-state.json`),
`*-receipts.ndjson` (`automation-receipts.ndjson`), `*-log.ndjson`
(`automation-log.ndjson`, `source-log.ndjson`), `source-comments.ndjson`.

Optional: config `include[]` may add extra **absolute** paths to the include set (e.g. a custom
knowledge mount), each sandboxed through `paths.ts`.

**The classification is total and fail-closed, at two layers.** `backup/paths.ts` exposes
`classify(scope, relPath)` returning `'include' | 'exclude' | null`, enumerated against every
filename each store module can emit (cross-checked against `.ai/cezar/.gitignore`'s `wanted` list
and the home path helpers in `paths.ts`). A path matching neither list is `null` — a **failure**,
not a default. Two layers enforce it: (1) at **test** time the N5 negative-control enumerates every
emittable filename and fails if any classifies to `null`, so a new store added upstream cannot
silently fall out of, or into, the backup; (2) at **run** time the walker (`backup/walk.ts`)
**refuses the whole run** — throwing and naming the path — the moment it meets a `null`-classified
file, rather than silently dropping it (a durable file lost, discovered only at restore) or shipping
it (a future store's secret leaking into the ciphertext). Because `backup.json` and OS junk are
classified, that throw fires only on a genuinely new cezar-written file whose classification a dev
has not added yet — exactly the case that must be loud (it surfaces as a failed run and a staling
`lastRun` in the cockpit).

## Architecture

```
                        CEZ_BACKUP=1  (exact string; else the whole subsystem is inert)
                              │
  due-scheduler ──every N min─┤            ┌───────────────── provider seam ─────────────────┐
  POST /backup/run ───────────┤            │  BackupProvider: put|get|head|list|delete        │
  cez backup run ─────────────┘            │    ├── providers/s3.ts   (SigV4 via node:crypto) │
                              ▼            │    └── providers/local.ts (tmp+rename)           │
                   ┌──────── snapshot engine ────────┐        └──────────────────────────────┘
   include set ──▶ │ walk → sha256 each file → diff  │              ▲
  (backup/paths)   │ last manifest → upload NEW blobs│──ciphertext──┘   remote layout:
                   │ → write manifest LAST (commit)  │                    blobs/<hmacKey>
                   └───────────────┬─────────────────┘                    snapshots/<ts>.manifest.enc
                                   │ every blob & manifest                 latest
                                   ▼ AES-256-GCM (backup/crypto)
                         masterKey = scrypt(CEZ_BACKUP_KEY | keyfile)
                         storageKey = HMAC-SHA256(masterKey, sha256(plaintext))

   restore: pick manifest → decrypt → per-blob fetch+decrypt+sha256 → staging dir → atomic move
            fail-closed on non-empty target without --force
```

- **Off the hot path (the performance guarantee).** The engine only *reads* corpus files. Every
  cezar store writes via atomic tmp+rename (`knowledge/catalog.ts`, `automations/store.ts`,
  `sources/store.ts`, the identity/config stores), so a read sees a complete file — old or new,
  never torn. Per-file consistency is guaranteed by the OS rename; cross-file skew self-corrects
  on the next run. **Backup never acquires a lock a writer needs.**
- **Single-run guard.** A run holds an `O_EXCL` lease (the `automations/store.ts` idiom) so an
  overlapping scheduled tick + manual `POST /backup/run` can't double-run. A tick that finds the
  lease held no-ops.
- **Scheduling.** Registered on the existing due-scheduler (`scheduling/due-scheduler.ts`,
  W1.6) every `intervalMinutes` (config, default 15). Off ⇒ never registered (no timer). A
  no-change run uploads nothing.
- **Workspace-level.** Mounts on `workspaceV1`, not the per-project router — backup is
  machine-wide.

## Data Models

**Remote layout (under `provider.prefix`):**
- `blobs/<hmacKey>` — one AES-256-GCM object per unique file content. `hmacKey =
  HMAC-SHA256(masterKey, sha256(plaintext))`, hex. Immutable, deduped, never rewritten.
  Ciphertext framing: `nonce(12) || ciphertext || authTag(16)`.
- `snapshots/<ts>.manifest.enc` — the encrypted manifest for one run, `<ts>` a stored ISO
  timestamp (sortable, filename-safe).
- `latest` — small encrypted object naming the current manifest key (pointer; written last).
- `keycheck` — a fixed known-plaintext encrypted under the master key (written once on first
  configured run; read by `verify`).

**Manifest (plaintext shape, before AES-GCM):**
```jsonc
{ "schemaVersion": 1,
  "createdAt": "2026-08-16T12:00:00.000Z",   // stored ISO — never recomputed at read time
  "entries": [
    { "path": "home/config.json",            // logical restore path (scope-prefixed)
      "sha256": "<hex>", "size": 3228, "hmacKey": "<hex>" }
    // ... one per included file
  ] }
```
Logical paths are scope-prefixed (`home/…`, `project/<projectId>/…`) so restore maps a blob
back to an absolute path without trusting the provider's key layout.

**Config (`~/.cezar/backup.json`, tolerant additive zod — `.passthrough()`):**
```json
{ "schemaVersion": 1, "enabled": true, "intervalMinutes": 15, "keepSnapshots": 30,
  "provider": { "kind": "s3", "endpoint": "https://<acct>.r2.cloudflarestorage.com",
                "bucket": "cezar-backup", "region": "auto", "prefix": "cezar/",
                "accessKeyEnv": "CEZ_BACKUP_S3_KEY", "secretKeyEnv": "CEZ_BACKUP_S3_SECRET" },
  "encryption": { "keyEnv": "CEZ_BACKUP_KEY" },
  "include": [] }
```
`kind: "local"` swaps `provider` for `{ "kind":"local", "path":"/Volumes/backup/cezar" }`.
`encryption` may instead carry `{ "keyFile": "/abs/path/to/keyfile" }`. **Secrets live in env**
(or a keyfile) — the config file names the env vars but never holds a key or an S3 secret
(mirrors `notifications/secrets.ts`). Documented in `.env.example` in the same commit ("an
undocumented env var is a bug").

`~/.cezar/backup.json` is its own file (not a key in `config.json`), on the
`notesPath()`/`agentAccountsPath()` precedent: a cezar version that never heard of backup does
not open it, so it cannot drop it.

## API Contracts (`/api/v1/backup/*`, workspace-level, chained family)

| Route | Success (flag on) | Flag-off (D19) |
|---|---|---|
| `GET  /api/v1/backup` | `{ enabled, provider, lastRun, snapshotCount, includeSummary }` | `200 { enabled:false, provider:null, lastRun:null, snapshotCount:0, includeSummary:null }` |
| `GET  /api/v1/backup/snapshots` | `{ snapshots: [{ id, createdAt, sizeBytes, blobCount }] }` | `200 { snapshots: [] }` |
| `POST /api/v1/backup/run` | `{ snapshotId, uploaded, skipped, bytes }` | `409` |
| `POST /api/v1/backup/restore` | `{ restored, staged, applied }` | `409` |
| `POST /api/v1/backup/verify` | `{ keyOk, providerOk, sampleRoundTrip }` | `409` |
| `POST /api/v1/backup/gc` | `{ prunedBlobs, freedBytes }` | `409` |

`lastRun` / `createdAt` are **stored** timestamps from the manifest — never `Date.now()` at
request time (D8). Zod request/response schemas live in `packages/contract/src/backup.ts`, both
directions parity-checked by `contract-parity.backup.test.ts`.

## Phases

Construction phases (2–8) → `spec-implementer` on Sonnet 5. Spec, scaffold (1), and
activation/e2e (9) stay on the session model.

1. **Scaffold (SOLO, session model).** ✅ `backupEnabled()` in `capabilities.ts`; contract domain
   `contract/src/backup.ts` + `index.ts` re-export; `server/backup-routes.ts` chained
   into `workspaceV1`; `BACKWARD_COMPATIBILITY.md` route inventory; `contract-parity.backup.test.ts`,
   `route-parity`/`typed-bodies` rows; the Settings → Backup section (self-gating, `account`-style —
   no nav-item/route edit); `.env.example` + README env-var row; `backup/paths.ts` + the
   include/exclude classification manifest & its N5 negative-control test.
2. **Provider seam + local provider** ✅ (`provider-types.ts`, `registry.ts`, `providers/local.ts` + tests).
3. **S3 provider** ✅ (`providers/s3.ts` + `providers/sigv4.ts`, SigV4 published-vector test + fetch-stubbed transport test).
4. **Crypto** ✅ (`backup/crypto.ts`: scrypt KDF, AES-GCM, HMAC storage keys, key-check token + round-trip tests).
5. **Snapshot engine + manifest** ✅ (`walk.ts`/`manifest.ts`/`snapshot.ts`: incremental diff, content-addressing, `gc`, `O_EXCL` lease; `scheduler.ts` over the due-scheduler). Walk is fail-closed on an unclassified path.
6. **Restore** ✅ (`restore.ts`: staging + atomic apply + sha256 verify + fail-closed overwrite guard that throws → 409).
7. **CLI** ✅ (`backup/cli.ts` + `cez backup` wired into `index.ts` — routed from raw argv so its `--snapshot`/`--force` flags survive the strict top-level `parseArgs`).
8. **Cockpit** ✅ (Settings → Backup section: provider/last-run/coverage/snapshots + Back-up-now/Verify/GC actions + a two-step force-confirm restore dialog; client mutations + query/mutation hooks).
9. **Activation + e2e (SOLO, session model).** ✅ Real route handlers behind the `CEZ_BACKUP` gate, `BackupScheduler` wired into `startServer` (armed only when flag on **and** `backup.json` `enabled`), the full gate run green, and the real-binary CLI smoke. CHANGELOG + Notion sync in the same session. Runtime R2 / live-server / browser E2E → QA Needed (see Status).

## Risks

- **Hand-rolled SigV4** is the riskiest no-dep bet. Mitigated by a test against AWS's published
  signing test vectors, and by the `local` provider fallback that needs no signing at all.
- **Key loss = unrecoverable backup** (inherent to zero-knowledge). Mitigated by `verify`
  (key-check token) + loud docs; the owner must store the key **off the Mac**.
- **Cross-file consistency is not transactional** (no multi-file txns exist in the corpus). A
  run can capture file A pre-write and file B post-write; the next run corrects the skew. Stated,
  not hidden.
- **Multi-process writers to `notes.json`** use an in-process mutex only — a pre-existing
  concern, out of scope here, noted for a follow-up.
- **Scaffold chokepoint churn.** `server.ts`, nav-items, routes.tsx, client, queries are
  upstream-churny; the scaffold keeps every edit additive and lands them in one commit.

## Performance / cost

Backup set is single-digit MiB today (home files are KBs; writable KB + notes + identity are
small), growing slowly. `sha256` over a few MiB is a few ms. 15-min cadence = 96 runs/day, **most
no-ops** (empty manifest diff ⇒ zero uploads). Even churny days are a handful of PUTs, trivially
inside R2's free tier (10M writes/mo). Restore fetches a few MiB (seconds). Scheduled-incremental
is cheap and never contends with agent I/O.

## Verification

Negative controls, cezar house style:

- **N1 Flag-off inertness.** `CEZ_BACKUP` unset ⇒ `/api/v1/health` byte-identical to the
  pre-change build; no timer registered, no network, no credential read; every backup GET is
  `200`-empty, every mutator `409`, **no `404`** anywhere in the family.
- **N2 Incrementality.** Run twice with no change ⇒ **zero** blob uploads; change one file ⇒
  exactly one new blob + one new manifest; the old `latest` stays valid until the new manifest
  lands.
- **N3 Round-trip.** Back up a fixture tree → wipe → restore ⇒ **byte-identical** files; `sha256`
  verified per blob.
- **N4 Zero-knowledge.** Every object PUT to the provider is ciphertext — a plaintext marker in a
  fixture file must **not** appear in any uploaded bytes. Wrong key ⇒ `verify` fails and restore
  refuses (not a garbage write).
- **N5 Scope classification (total, fail-closed).** Every filename any store can emit is
  classified include or exclude; a path matching neither **fails** the test.
  `runs.json` / `knowledge-index/` / `launch-key` / `*.lock` are asserted **excluded**;
  `knowledge/**`, `config.json`, `identity/identity.json` asserted **included**.
- **N6 Fail-closed restore.** Restore into a non-empty target without `--force` refuses and
  writes nothing.
- **N7 SigV4.** The signer matches AWS's published test-suite vectors (canonical request →
  string-to-sign → signature).

**Runtime E2E (decides Done vs QA Needed).** Configure a real R2 bucket (`CEZ_BACKUP_S3_KEY` /
`CEZ_BACKUP_S3_SECRET` / `CEZ_BACKUP_KEY` in env), run a scheduled backup, delete a local
knowledge doc, restore it, and confirm in the cockpit + on disk. A `local`-provider round-trip is
the self-serve smoke test. Until the R2 E2E passes, the Notion task stays **QA Needed**.
